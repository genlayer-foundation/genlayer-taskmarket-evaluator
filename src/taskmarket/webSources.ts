import { z } from "zod";

const domain = z.string().max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
  .refine(host => !/\.(?:local|localhost|localdomain|internal|invalid|test|example|onion|arpa)$/.test(host),
    "Use an exact public DNS name");
export const webDomains = z.array(domain).min(1).max(8)
  .refine(names => new Set(names).size === names.length, "Use each domain once");

// The fourth distinct URL signals overflow to the jury. Never choose a subset to judge.
export function webSources(domains: string[], texts: string[]) {
  const urls = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/https:\/\/[^\s<>"'`|\\]+/gi)) {
      let raw = match[0].replace(/[.,;:!?\]]+$/g, "");
      const extraClosing = raw.split(")").length - raw.split("(").length;
      const trailing = raw.match(/\)+$/)?.[0].length ?? 0;
      if (extraClosing > 0 && trailing) raw = raw.slice(0, -Math.min(extraClosing, trailing));
      if (!URL.canParse(raw)) continue;
      const url = new URL(raw);
      if (!domains.includes(url.hostname) || url.username || url.password || url.port) continue;
      url.hash = "";
      urls.add(url.href);
      if (urls.size === 4) return { domains, urls: [...urls] };
    }
  }
  return { domains, urls: [...urls] };
}
