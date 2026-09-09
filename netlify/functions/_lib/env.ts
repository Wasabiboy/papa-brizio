export function env(name: string) {
  return Netlify.env.get(name)?.trim() || "";
}
