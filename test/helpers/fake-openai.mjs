// Scripted OpenAI-compatible server. responder(body, index) returns the JSON reply,
// or {status, text} for a raw error response. Records every request's headers and body.
import { createServer } from "node:http";

export const reply = (message, usage = { prompt_tokens: 1, completion_tokens: 1 }) => ({ choices: [{ message }], usage });
export const toolCall = (name, args, id = "call_1") => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

export async function startFakeOpenAI(responder) {
  const requests = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = data ? JSON.parse(data) : null;
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      const out = responder(body, requests.length - 1, req);
      if (out && out.status) {
        res.writeHead(out.status).end(out.text ?? "");
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
