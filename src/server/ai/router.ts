import { KB_CATEGORIES, type AgentKind, type AiModelChoice, type KbCategory, type TaskClass } from "../../shared/ai";
import type { AiKeys } from "./keys";
import { completeJson, type Usage } from "./provider";
import { ROUTER_PROMPT } from "./prompts";

/**
 * Task router: one small, cheap call decides the task class (hence the model tier), which
 * knowledge categories to search and the search query. Falls back to keywords when the
 * router model fails, so a request is never blocked by routing.
 */

export type Route = { task: TaskClass; kb: KbCategory[]; query: string; by: "model" | "rules" | "fixed"; usage: Usage };

const ROUTABLE: readonly TaskClass[] = ["CHAT", "LOOKUP", "KNOWLEDGE", "ANALYSIS", "PLANNING", "CREATIVE"];

const has = (text: string, words: string[]) => words.some((w) => text.includes(w));

/** Keyword rules (Vietnamese, accents folded) used when the router model is unavailable. */
export function ruleRoute(text: string, kind: AgentKind): Omit<Route, "usage" | "by"> {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d");
  const uw = has(t, ["tham dinh", "kham suc khoe", "ho so yeu cau", "hsycbh", "underwriting", "loai tru", "tang phi"]);
  const service = has(t, [
    "boi thuong",
    "quyen loi",
    "thay doi",
    "khoi phuc",
    "dong phi",
    "dao han",
    "huy hop dong",
    "rut tien",
    "thu tuc",
    "quy trinh",
    "giay to",
    "mau don",
  ]);
  const product = has(t, ["san pham", "dieu khoan", "quyen loi", "phu hop", "ban them", "upsell", "cross", "goi y"]);
  if (has(t, ["uu tien", "kha nang chot", "xep hang", "phan tich", "phu hop", "ban them", "ban cheo", "lo hong", "thieu bao hiem"]))
    return { task: "ANALYSIS", kb: product ? ["PRODUCT"] : [], query: text };
  if (uw || service || (kind === "OPS" && t.length > 12))
    return {
      task: "KNOWLEDGE",
      kb: [...(uw ? ["UNDERWRITING" as const] : []), ...(service ? ["SERVICE" as const] : []), ...(product ? ["PRODUCT" as const] : [])],
      query: text,
    };
  if (product) return { task: "KNOWLEDGE", kb: ["PRODUCT"], query: text };
  if (has(t, ["ke hoach", "sap xep", "hom nay", "ngay mai", "tuan nay", "buoc tiep", "nen lam gi", "viec can lam"]))
    return { task: "PLANNING", kb: [], query: "" };
  if (has(t, ["qua tang", "tang qua", "soan", "viet tin", "tin nhan", "loi chuc", "kich ban"])) return { task: "CREATIVE", kb: [], query: "" };
  if (t.length < 25 && has(t, ["cam on", "chao", "ok", "hello", "hi "])) return { task: "CHAT", kb: [], query: "" };
  return { task: "LOOKUP", kb: [], query: "" };
}

export async function routeTask(keys: AiKeys, router: AiModelChoice, kind: AgentKind, context: string, recent: string[], text: string): Promise<Route> {
  const zero = { inputTokens: 0, outputTokens: 0 };
  try {
    const { data, usage } = await completeJson(
      keys,
      router,
      [
        { role: "system", content: ROUTER_PROMPT },
        { role: "user", content: `Assistant: ${kind}. Screen: ${context}.\nRecent turns:\n${recent.join("\n") || "(none)"}\n\nLatest message:\n${text}` },
      ],
      300,
    );
    const r = data as { task?: string; kb?: unknown; query?: unknown } | null;
    if (r && ROUTABLE.includes(r.task as TaskClass)) {
      const kb = Array.isArray(r.kb) ? r.kb.filter((k): k is KbCategory => (KB_CATEGORIES as readonly string[]).includes(k as string)) : [];
      return { task: r.task as TaskClass, kb, query: typeof r.query === "string" ? r.query.slice(0, 300) : "", by: "model", usage };
    }
  } catch {
    // Routing is an optimisation: fall back to rules.
  }
  return { ...ruleRoute(text, kind), by: "rules", usage: zero };
}
