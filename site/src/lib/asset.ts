// Public files live under the site's base path (/Luna/ on GitHub Pages).
export function asset(path: string, base: string = import.meta.env.BASE_URL): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
