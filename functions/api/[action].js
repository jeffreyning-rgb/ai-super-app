// AI 超级应用 · Pages Functions API（与 Muse 版 MVP 相同的动作名）
// 数据存 Cloudflare D1（binding: DB）
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function bootstrap(db) {
  const [messages, todos, expenses, memories, tasks, steps] = await Promise.all([
    db.prepare("SELECT id, role, content, created_at FROM messages ORDER BY id ASC LIMIT 200").all(),
    db.prepare("SELECT id, title, done, created_at FROM todos ORDER BY id DESC").all(),
    db.prepare("SELECT id, item, amount, created_at FROM expenses ORDER BY id DESC").all(),
    db.prepare("SELECT id, key, value, updated_at FROM memories ORDER BY id DESC").all(),
    db.prepare("SELECT id, title, status, created_at FROM tasks ORDER BY id DESC").all(),
    db.prepare("SELECT id, task_id, title, done, position FROM task_steps ORDER BY position ASC, id ASC").all(),
  ]);
  const taskList = tasks.results.map((t) => ({
    ...t,
    steps: steps.results.filter((s) => s.task_id === t.id),
  }));
  const expenseTotal = expenses.results.reduce((s, e) => s + (e.amount || 0), 0);
  return {
    messages: messages.results,
    todos: todos.results,
    expenses: expenses.results,
    memories: memories.results,
    tasks: taskList,
    stats: {
      todoOpen: todos.results.filter((t) => !t.done).length,
      expenseTotal,
      memoryCount: memories.results.length,
      taskOpen: taskList.filter((t) => t.status !== "done").length,
    },
  };
}

async function getSettings(db) {
  const rows = await db.prepare("SELECT key, value FROM settings").all();
  const s = {};
  for (const r of rows.results) s[r.key] = r.value;
  return {
    provider: s.provider || "deepseek",
    base_url: s.base_url || "https://api.deepseek.com",
    model: s.model || "deepseek-chat",
    protocol: s.protocol || "openai",
    api_key: s.api_key || "",
  };
}

async function setSetting(db, key, value) {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .bind(key, value)
    .run();
}

// 大模型调用：三种协议
// openai    —— OpenAI 兼容接口（DeepSeek / OpenAI / 通义 / 智谱 / Kimi / 硅基流动 / OpenRouter 等）
// anthropic —— Claude 原生接口
// gemini    —— Google Gemini 原生接口
function mergeTurns(history) {
  const out = [];
  for (const m of history) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function fetchJSON(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error((out.error && out.error.message) || `HTTP ${resp.status}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function callLLM(db, settings) {
  const hist = await db.prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT 12").all();
  const history = hist.results.reverse().map((m) => ({ role: m.role, content: m.content }));
  const data = await bootstrap(db);
  const memText = data.memories.map((mm) => `${mm.key}：${mm.value}`).join("；") || "无";
  const todoText = data.todos.filter((t) => !t.done).map((t) => t.title).join("；") || "无";
  const system =
    "你是「AI 超级应用」里的个人助手，用简洁自然的中文回答，不要长篇大论。" +
    `你知道用户的一部分数据：未完成待办：${todoText}。支出合计：${data.stats.expenseTotal} 元。长期记忆：${memText}。` +
    "用户问到这些数据时直接根据上面回答，不要编造没有的数据。";
  const base = settings.base_url.replace(/\/+$/, "");
  const protocol = settings.protocol || "openai";
  let text = "";
  if (protocol === "anthropic") {
    const out = await fetchJSON(base + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.api_key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: settings.model, max_tokens: 1024, system, messages: mergeTurns(history) }),
    });
    text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  } else if (protocol === "gemini") {
    const out = await fetchJSON(`${base}/v1beta/models/${settings.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": settings.api_key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: mergeTurns(history).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      }),
    });
    const parts = out.candidates && out.candidates[0] && out.candidates[0].content && out.candidates[0].content.parts;
    text = (parts || []).map((p) => p.text || "").join("");
  } else {
    const out = await fetchJSON(base + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.api_key}` },
      body: JSON.stringify({ model: settings.model, messages: [{ role: "system", content: system }, ...history], temperature: 0.7 }),
    });
    text = out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
  }
  if (!text) throw new Error("模型没有返回内容");
  return String(text).trim();
}

// 规则版意图识别：记账 / 待办 / 记忆 / 任务，其余走大模型（未配置时给提示）
async function handleChat(db, content) {
  const text = (content || "").trim();
  await db.prepare("INSERT INTO messages (role, content) VALUES ('user', ?)").bind(text).run();
  let reply = null;

  let m = text.match(/(?:花了|花费|支出|买.+?花?了?)\s*(\d+(?:\.\d+)?)\s*元?/);
  if (!m) m = text.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*元$/);
  if (m && /花|买|支出|元/.test(text)) {
    const item = (text.replace(/\d+(?:\.\d+)?\s*元?/, "").replace(/^(记账|记录|我)?(花了|买了)?/, "").trim()) || "支出";
    const amount = parseFloat(m[1] !== undefined && /\d/.test(m[1]) && m.length > 2 ? m[2] || m[1] : m[1]);
    const amt = parseFloat(m[2] || m[1]);
    await db.prepare("INSERT INTO expenses (item, amount) VALUES (?, ?)").bind(item.slice(0, 40), amt).run();
    reply = `记好了：${item.slice(0, 40)} ${amt} 元，已存进账本。`;
  } else if (/^(待办|提醒我|记得|记一下|添加待办)[:：]?\s*/.test(text) || /待办/.test(text.slice(0, 4))) {
    const title = text.replace(/^(待办|提醒我|记得|记一下|添加待办)[:：]?\s*/, "").replace(/待办[:：]?/, "").trim();
    if (title) {
      await db.prepare("INSERT INTO todos (title) VALUES (?)").bind(title).run();
      reply = `已加到待办：${title}`;
    }
  } else if (/^记住[:：]?\s*/.test(text) || /帮我记住/.test(text)) {
    const body = text.replace(/^(请)?(帮我)?记住[:：]?\s*/, "").trim();
    const kv = body.split(/[:：=是]/);
    const key = (kv[0] || "备注").trim().slice(0, 30) || "备注";
    const value = (kv.slice(1).join("：") || body).trim();
    await db
      .prepare("INSERT INTO memories (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
      .bind(key, value)
      .run();
    reply = `记住了：${key} — ${value}`;
  } else if (/^(任务|计划)[:：]?\s*/.test(text)) {
    const title = text.replace(/^(任务|计划)[:：]?\s*/, "").trim();
    if (title) {
      const r = await db.prepare("INSERT INTO tasks (title) VALUES (?)").bind(title).run();
      const steps = ["明确目标和完成标准", "拆解所需材料和步骤", "排出时间表并开始第一步", "检查结果并收尾"];
      for (let i = 0; i < steps.length; i++) {
        await db.prepare("INSERT INTO task_steps (task_id, title, position) VALUES (?, ?, ?)").bind(r.meta.last_row_id, steps[i], i).run();
      }
      reply = `任务「${title}」建好了，先拆成 ${steps.length} 步，放在右侧任务区。`;
    }
  }
  if (!reply) {
    const settings = await getSettings(db);
    if (settings.api_key) {
      try {
        reply = await callLLM(db, settings);
      } catch (e) {
        reply = `大模型调用失败：${String(e && e.message || e)}。检查一下模型设置里的 key 和模型名，或者稍后再试。`;
      }
    } else {
      reply = "收到。记账、加待办、让我记住某件事、建任务，都可以直接跟我说。想跟我聊天问答，先在上方「模型设置」里填一个大模型 API key（推荐 DeepSeek）。";
    }
  }
  await db.prepare("INSERT INTO messages (role, content) VALUES ('assistant', ?)").bind(reply).run();
  return reply;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  if (!db) return json({ error: "D1 未绑定" }, 500);
  const action = params.action;
  let body = {};
  if (request.method === "POST") {
    try { body = await request.json(); } catch { body = {}; }
  }
  try {
    switch (action) {
      case "getbootstrap":
        return json(await bootstrap(db));
      case "getsettings": {
        const s = await getSettings(db);
        return json({ provider: s.provider, base_url: s.base_url, model: s.model, protocol: s.protocol, has_key: !!s.api_key, key_tail: s.api_key ? s.api_key.slice(-4) : "" });
      }
      case "savesettings": {
        if (body.provider !== undefined) await setSetting(db, "provider", String(body.provider).slice(0, 30));
        if (body.base_url !== undefined) await setSetting(db, "base_url", String(body.base_url).trim().slice(0, 200));
        if (body.model !== undefined) await setSetting(db, "model", String(body.model).trim().slice(0, 60));
        if (body.protocol !== undefined) await setSetting(db, "protocol", String(body.protocol).slice(0, 20));
        if (body.api_key) await setSetting(db, "api_key", String(body.api_key).trim());
        const s = await getSettings(db);
        return json({ ok: true, provider: s.provider, base_url: s.base_url, model: s.model, protocol: s.protocol, has_key: !!s.api_key, key_tail: s.api_key ? s.api_key.slice(-4) : "" });
      }
      case "sendmessage": {
        const reply = await handleChat(db, body.content || "");
        return json({ reply, ...(await bootstrap(db)) });
      }
      case "clearchat":
        await db.prepare("DELETE FROM messages").run();
        return json(await bootstrap(db));
      case "addtodo":
        await db.prepare("INSERT INTO todos (title) VALUES (?)").bind((body.title || "").trim()).run();
        return json(await bootstrap(db));
      case "toggletodo":
        await db.prepare("UPDATE todos SET done = ? WHERE id = ?").bind(body.done ? 1 : 0, body.id).run();
        return json(await bootstrap(db));
      case "deletetodo":
        await db.prepare("DELETE FROM todos WHERE id = ?").bind(body.id).run();
        return json(await bootstrap(db));
      case "addexpense":
        await db.prepare("INSERT INTO expenses (item, amount) VALUES (?, ?)").bind((body.item || "").trim(), parseFloat(body.amount) || 0).run();
        return json(await bootstrap(db));
      case "deleteexpense":
        await db.prepare("DELETE FROM expenses WHERE id = ?").bind(body.id).run();
        return json(await bootstrap(db));
      case "savememory":
        await db
          .prepare("INSERT INTO memories (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
          .bind((body.key || "").trim(), (body.value || "").trim())
          .run();
        return json(await bootstrap(db));
      case "deletememory":
        await db.prepare("DELETE FROM memories WHERE id = ?").bind(body.id).run();
        return json(await bootstrap(db));
      case "createtask": {
        const r = await db.prepare("INSERT INTO tasks (title) VALUES (?)").bind((body.title || "").trim()).run();
        const steps = Array.isArray(body.steps) && body.steps.length ? body.steps : ["明确目标和完成标准", "拆解所需材料和步骤", "排出时间表并开始第一步", "检查结果并收尾"];
        for (let i = 0; i < steps.length; i++) {
          await db.prepare("INSERT INTO task_steps (task_id, title, position) VALUES (?, ?, ?)").bind(r.meta.last_row_id, String(steps[i]), i).run();
        }
        return json(await bootstrap(db));
      }
      case "toggletaskstep": {
        await db.prepare("UPDATE task_steps SET done = ? WHERE id = ?").bind(body.done ? 1 : 0, body.id).run();
        const t = await db.prepare("SELECT task_id FROM task_steps WHERE id = ?").bind(body.id).first();
        if (t) {
          const left = await db.prepare("SELECT COUNT(*) AS c FROM task_steps WHERE task_id = ? AND done = 0").bind(t.task_id).first();
          await db.prepare("UPDATE tasks SET status = ? WHERE id = ?").bind(left.c === 0 ? "done" : "open", t.task_id).run();
        }
        return json(await bootstrap(db));
      }
      case "deletetask":
        await db.prepare("DELETE FROM task_steps WHERE task_id = ?").bind(body.id).run();
        await db.prepare("DELETE FROM tasks WHERE id = ?").bind(body.id).run();
        return json(await bootstrap(db));
      default:
        return json({ error: `未知动作 ${action}` }, 404);
    }
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}
