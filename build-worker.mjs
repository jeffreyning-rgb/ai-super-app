// 把 public/index.html 与 functions/api/[action].js 打包成单个 Worker 文件 worker.js
// 用法：node build-worker.mjs
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
let api = readFileSync(new URL("./functions/api/[action].js", import.meta.url), "utf8");

api = api.replace(
  `export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;`,
  `async function handleApi(action, request, env) {
  const db = env.DB;`
);
api = api.replace("  const action = params.action;\n", "");

const worker = `${api}
const HTML = ${JSON.stringify(html)};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(url.pathname.slice(5), request, env);
    }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
`;

writeFileSync(new URL("./worker.js", import.meta.url), worker);
console.log("worker.js generated:", worker.length, "bytes");
