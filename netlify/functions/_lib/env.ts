export function env(name: string) {
  const fromNetlify = typeof Netlify === "undefined" ? "" : Netlify.env.get(name);
  const fromProcess = typeof process === "undefined" ? "" : process.env[name];
  return String(fromNetlify || fromProcess || "").trim();
}
