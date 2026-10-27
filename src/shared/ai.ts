import { z } from "zod";

/**
 * AI assistants (docs/SPEC-ai.md). Providers are reached through their OpenAI-compatible
 * chat endpoints; the GA Head picks provider and model per tier, per agent if needed.
 */

export const AI_PROVIDERS = ["GEMINI", "DEEPSEEK", "QWEN"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** Endpoint, Worker secret holding the API key, and fallback model ids (the settings page loads the live list from the provider). */
export const PROVIDER_INFO: Record<
  AiProvider,
  { label: string; baseUrl: string; secret: "GEMINI_API_KEY" | "DEEPSEEK_API_KEY" | "QWEN_API_KEY"; models: string[] }
> = {
  GEMINI: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    secret: "GEMINI_API_KEY",
    models: ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.1-pro-preview"],
  },
  DEEPSEEK: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", secret: "DEEPSEEK_API_KEY", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  QWEN: {
    label: "Qwen (Alibaba Cloud, quốc tế)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    secret: "QWEN_API_KEY",
    models: ["qwen-flash", "qwen-plus", "qwen-max"],
  },
};

export const modelChoiceSchema = z.object({ provider: z.enum(AI_PROVIDERS), model: z.string().trim().min(1).max(100) });
export type AiModelChoice = z.infer<typeof modelChoiceSchema>;

/** Cost / capability tiers. Each task class runs on one tier. */
export const AI_TIERS = ["FAST", "BALANCED", "DEEP"] as const;
export type AiTier = (typeof AI_TIERS)[number];

/**
 * Task classes the router sorts each request into, so a cheap model answers simple
 * questions and the knowledge base is searched only when needed.
 */
export const TASK_CLASSES = ["CHAT", "LOOKUP", "KNOWLEDGE", "ANALYSIS", "PLANNING", "CREATIVE", "ROLEPLAY", "EVALUATION"] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

export const DEFAULT_TASK_TIER: Record<TaskClass, AiTier> = {
  CHAT: "FAST",
  LOOKUP: "FAST",
  KNOWLEDGE: "BALANCED",
  ANALYSIS: "DEEP",
  PLANNING: "BALANCED",
  CREATIVE: "BALANCED",
  ROLEPLAY: "BALANCED",
  EVALUATION: "DEEP",
};

/** Tasks that read the knowledge base before answering. */
export const KB_TASKS: readonly TaskClass[] = ["KNOWLEDGE", "ANALYSIS"];
/** Tasks that may call CRM / knowledge tools. */
export const TOOL_TASKS: readonly TaskClass[] = ["LOOKUP", "KNOWLEDGE", "ANALYSIS", "PLANNING", "CREATIVE"];

/**
 * Behaviour frame of an agent. CUSTOM has no built-in role: the GA Head's instructions
 * define it entirely. COACH runs the role-play practice (setup form, scoring).
 */
export const AGENT_KINDS = ["CUSTOM", "ASSISTANT", "OPS", "COACH"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
/** The assistants every GA starts with. */
export const DEFAULT_AGENT_KINDS = ["ASSISTANT", "OPS", "COACH"] as const;

export const quickPromptSchema = z.object({ label: z.string().trim().min(1).max(60), text: z.string().trim().min(1).max(1000) });
export const agentConfigSchema = z.object({
  /** Read the CRM data of the screen (lead, client, lists, the FC's day). */
  crmData: z.boolean(),
  /** May call CRM and knowledge tools during an answer. */
  tools: z.boolean(),
  /** Buttons shown before the first question; empty = the built-in ones of the kind. */
  quickPrompts: z.array(quickPromptSchema).max(8),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export const defaultAgentConfig = (kind: AgentKind): AgentConfig => ({ crmData: kind !== "OPS", tools: kind !== "COACH", quickPrompts: [] });

/** Where the assistant is opened; decides which CRM data it sees. */
export const AI_CONTEXTS = ["GENERAL", "LEAD", "CLIENT", "LEAD_LIST", "CLIENT_LIST"] as const;
export type AiContext = (typeof AI_CONTEXTS)[number];

export const KB_CATEGORIES = ["PRODUCT", "UNDERWRITING", "SERVICE", "SALES", "OTHER"] as const;
export type KbCategory = (typeof KB_CATEGORIES)[number];

export const DEFAULT_TIERS: Record<AiTier, AiModelChoice> = {
  FAST: { provider: "GEMINI", model: "gemini-3.5-flash-lite" },
  BALANCED: { provider: "GEMINI", model: "gemini-3.5-flash" },
  DEEP: { provider: "GEMINI", model: "gemini-3.1-pro-preview" },
};
export const DEFAULT_MONTHLY_TOKENS = 5_000_000;

/* ---------- Objection-handling practice ---------- */

export const COACH_SCENARIOS = ["NO_MONEY", "ASK_SPOUSE", "DISTRUST", "HAS_INSURANCE", "NOT_NOW", "SAVINGS_BETTER", "TOO_YOUNG", "CUSTOM"] as const;
export const COACH_DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;

export const coachSetupSchema = z.object({
  scenario: z.enum(COACH_SCENARIOS),
  difficulty: z.enum(COACH_DIFFICULTIES),
  /** Who the customer is (age, job, family), free text. */
  persona: z.string().trim().max(500).optional(),
  product: z.string().trim().max(200).optional(),
  custom: z.string().trim().max(500).optional(),
  /** Base the customer on one of the FC's leads (pseudonymised). */
  leadId: z.string().max(64).optional(),
});
export type CoachSetup = z.infer<typeof coachSetupSchema>;

export const COACH_CRITERIA = ["OPENING", "DISCOVERY", "EMPATHY", "OBJECTION", "LANGUAGE", "CLOSING"] as const;
export const coachScoreSchema = z.object({
  overall: z.number().min(0).max(100),
  criteria: z.array(z.object({ key: z.enum(COACH_CRITERIA), score: z.number().min(0).max(10), comment: z.string() })),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  betterLines: z.array(z.object({ original: z.string(), suggestion: z.string() })),
  persuasionOptions: z.array(z.string()),
  verdict: z.string(),
});
export type CoachScore = z.infer<typeof coachScoreSchema>;

/* ---------- API schemas ---------- */

export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  tiers: z.object({ FAST: modelChoiceSchema, BALANCED: modelChoiceSchema, DEEP: modelChoiceSchema }),
  router: modelChoiceSchema,
  monthlyTokenLimit: z.number().int().min(0).max(1_000_000_000),
});

export const aiAgentSchema = z.object({
  kind: z.enum(AGENT_KINDS),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullish(),
  enabled: z.boolean(),
  instructions: z.string().trim().min(1).max(8000),
  contexts: z.array(z.enum(AI_CONTEXTS)).min(1),
  models: z.object({ FAST: modelChoiceSchema.optional(), BALANCED: modelChoiceSchema.optional(), DEEP: modelChoiceSchema.optional() }),
  taskTiers: z.partialRecord(z.enum(TASK_CLASSES), z.enum(AI_TIERS)),
  kbIds: z.array(z.string().max(64)).max(50),
  config: agentConfigSchema,
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

export const knowledgeBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  category: z.enum(KB_CATEGORIES),
  enabled: z.boolean(),
});

/** Text is extracted in the browser (txt, md, docx, pdf) and sent as plain text. */
export const MAX_DOC_CHARS = 400_000;
export const documentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  productCode: z.string().trim().max(40).nullish(),
  sourceName: z.string().trim().max(200).nullish(),
  text: z.string().min(1).max(MAX_DOC_CHARS),
});

export const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  productCode: z.string().trim().max(40).nullish(),
});

/** A GA's own provider key. Only its last 4 characters are ever shown again. */
export const providerKeySchema = z.object({ apiKey: z.string().trim().min(8).max(500) });

export const createConversationSchema = z.object({
  agentId: z.string().max(64),
  context: z.enum(AI_CONTEXTS),
  contextRef: z.string().max(64).optional(),
  coach: coachSetupSchema.optional(),
});

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  /** Quick actions know their task already: the router is skipped (saves a call). */
  task: z.enum(TASK_CLASSES).optional(),
});

export const kbSearchSchema = z.object({ q: z.string().trim().min(1).max(200) });
