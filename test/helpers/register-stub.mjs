// --import target: installs the SDK-stubbing resolve hook before dist loads.
import { register } from "node:module";
register("./stub-hooks.mjs", import.meta.url);
