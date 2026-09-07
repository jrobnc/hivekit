// Module-resolution hook: redirects the Agent SDK specifier to the local fake.
// Registered from test/helpers/register-stub.mjs via node:module register().
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_URL = pathToFileURL(join(HERE, "fake-sdk.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@anthropic-ai/claude-agent-sdk") {
    return { url: FAKE_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
