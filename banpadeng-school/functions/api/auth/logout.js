import { buildClearCookie } from "../../_lib/crypto.js";
import { jsonResponse } from "../../_lib/auth.js";

export async function onRequestPost() {
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": buildClearCookie() });
}
