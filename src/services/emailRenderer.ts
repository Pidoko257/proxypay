import Handlebars from "handlebars";
import fs from "fs";
import path from "path";

const TEMPLATES_DIR = path.join(__dirname, "../email-templates");

// Cache compiled templates
const cache = new Map<string, HandlebarsTemplateDelegate>();

function load(name: string): HandlebarsTemplateDelegate {
  const cached = cache.get(name);
  if (cached) return cached;

  const file = path.join(TEMPLATES_DIR, `${name}.hbs`);
  const source = fs.readFileSync(file, "utf8");
  const compiled = Handlebars.compile(source);
  cache.set(name, compiled);
  return compiled;
}

// Compile and cache the layout once
function getLayout(): HandlebarsTemplateDelegate {
  return load("_layout");
}

export interface RenderedEmail {
  html: string;
  text: string;
}

/**
 * Render a named Handlebars template with the given context.
 * Returns both an HTML version (wrapped in the shared layout) and a plain-text fallback.
 */
export function renderTemplate(templateName: string, context: Record<string, unknown>): RenderedEmail {
  const bodyTemplate = load(templateName);
  const body = bodyTemplate({ ...context, year: new Date().getFullYear() });

  const layoutTemplate = getLayout();
  const html = layoutTemplate({ ...context, body, year: new Date().getFullYear() });

  const text = buildPlainText(templateName, context);
  return { html, text };
}

/**
 * Minimal plain-text fallback — strips HTML tags from the rendered body.
 * Preserves newlines by converting block-level tags first.
 */
function buildPlainText(templateName: string, context: Record<string, unknown>): string {
  const bodyTemplate = load(templateName);
  const html = bodyTemplate({ ...context, year: new Date().getFullYear() });

  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|h[1-6]|li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&copy;/g, "©")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clear template cache (useful in tests). */
export function clearTemplateCache(): void {
  cache.clear();
}
