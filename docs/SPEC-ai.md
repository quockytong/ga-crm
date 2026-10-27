# AI assistants (Trợ lý AI): spec and design

State on 26 Oct 2026. Product-owner decisions are marked **PO**.

## 1. What it does
Three kinds of assistant, each a configurable "agent" per GA:

| Kind | Default name | Job |
|---|---|---|
| ASSISTANT | Trợ lý bán hàng | Plan the day, summarise interactions and manager feedback, next best action, rank leads by likelihood to close, product fit / upsell / cross-sell, gift ideas, Zalo messages, performance tips |
| OPS | Chuyên gia vận hành | Q&A on underwriting, policy services, procedures, grounded in the knowledge bases, with citations |
| COACH | Luyện xử lý từ chối | Role-plays a hard Vietnamese customer (scenario, difficulty, persona, optional lead); then scores the FC (6 criteria, 0-100), with better lines and alternative ways to persuade |

The GA Head can also add any number of own assistants ("Thêm trợ lý"): free name, description and prompt, kind CUSTOM (no built-in role: the GA's instructions are the role) or one of the frames above, screens, knowledge bases, models, and per agent `config` = { crmData (read the screen's CRM data), tools (may look up more), quickPrompts (up to 8 buttons; empty = built-in ones) }. The fixed rules (privacy, citations, product-suggestion label) always apply.

The assistant opens from a floating button on every page (`ai.use`). The screen is its context:
lead detail = that lead, client detail = client 360, lead list / client list = the FC's lists,
anywhere else = the FC's day (ASSISTANT) or no CRM data (OPS). Conversations are private to their user.

## 2. Decisions
- **PO, pseudonymised data**: providers never see names, phones, emails, addresses, client codes or policy numbers. People and policies become tokens ([K1] client, [L1] lead, [N1] relative, [A1] colleague, [P1] policy), stable per conversation (`ai_conversations.pseudonyms`); the browser shows the real names. Sentences about health in CRM notes are replaced by "[thông tin sức khỏe đã ẩn]" (product words such as "bảo hiểm sức khỏe", "bệnh hiểm nghèo" are kept). Names written in free text that the CRM does not know cannot be detected: the FC is told so in the drawer footer.
- **PO, product suggestions allowed, labelled**: shown under "Gợi ý AI – cần kiểm tra trước khi tư vấn", based on coverage, family and product documents, citing sources. The 11_Products fit rules are still DRAFT; the label stays until they are approved.
- **PO, providers**: Google Gemini, DeepSeek, Qwen (Alibaba Cloud international endpoint), all through their OpenAI-compatible chat API (`src/server/ai/provider.ts`).
- **PO, keys per GA**: the GA Head enters the GA's own API key per provider ("Khóa API của nhà cung cấp" on the models tab). Stored encrypted (AES-GCM, key derived with HKDF from `AI_KEYS_SECRET`, else `BETTER_AUTH_SECRET`; tenant and provider bound as additional data), write-only: the API returns only the last 4 characters, the audit row never holds the key. Without a GA key the platform's Worker secret (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `QWEN_API_KEY`) is used; with neither, the provider is unavailable. "Kiểm tra" sends a 5-token request on a model of that provider. Rotating the encryption secret makes stored keys unreadable (flagged on screen; re-enter them). A rejected key is `ai_key_invalid`. Model ids are not hard-coded: once a key is set, the settings page lists the provider's live chat models (`GET /admin/keys/:provider/models`, the provider's `/models`); `PROVIDER_INFO` only holds fallbacks. A retired model answers 404 → `ai_model_unavailable` ("chọn mô hình khác"). Google retired Gemini 2.5 for new users in Oct 2026; defaults are now gemini-3.5-flash-lite / gemini-3.5-flash / gemini-3.1-pro-preview.
- Scope: every CRM read goes through the same scope helpers as the screens (`clientInScope`, `visibleLeads`...). Tools only resolve tokens of the current conversation. Every lead / client read for the AI writes an `AI_READ` audit row.
- Managers do not see their FCs' conversations. The GA Head sees usage only.

## 3. Task routing (token optimisation)
Each question is classified into a task class; the class picks a tier, the tier picks a model.

| Task | Default tier | Knowledge searched first | Tools |
|---|---|---|---|
| CHAT | FAST | no | no |
| LOOKUP | FAST | if the router asks | yes |
| KNOWLEDGE | BALANCED | yes | yes |
| ANALYSIS | DEEP | yes | yes |
| PLANNING | BALANCED | if the router asks | yes |
| CREATIVE | BALANCED | if the router asks | yes |
| ROLEPLAY (coach, fixed) | BALANCED | no | no |
| EVALUATION (scoring, fixed) | DEEP | no | no |

- The router is one small JSON call on the GA's router model (`ROUTER_PROMPT`): task, knowledge categories, search query. If it fails, keyword rules decide (`ruleRoute`). Quick-action buttons send their task and skip the router.
- GA settings: model per tier (FAST, BALANCED, DEEP) and the router model. Per agent: optional model per tier and tier per task.
- The prompt prefix (fixed rules, GA instructions, CRM data) is kept byte-stable within a conversation so providers can cache it; knowledge passages go with the question.
- Tools (`run.ts`): search_knowledge, get_lead, get_client, list_leads, list_clients, my_day; at most 4 rounds.
- Monthly token budget per GA (`ai_settings.monthly_token_limit`, 0 = none): 429 `ai_budget_exceeded`.

## 4. Knowledge bases
- Per GA, shared by its agents (linked per agent). Category: PRODUCT, UNDERWRITING, SERVICE, SALES, OTHER.
- Several files can be uploaded at once (one document per file, titled after the file, read and saved one by one with a status per file).
- Title and product code can be changed after upload (the text cannot: delete and upload again).
- Documents (PDF, DOCX, TXT, MD) are read in the browser (`src/client/lib/extract-text.ts`); scanned PDFs have no text and must be pasted. Up to 400,000 characters per document, optional product code (so a client's products rank their documents first).
- Chunks of about 1,200 characters under their heading, FTS5 index `ai_chunks_fts` (BM25, diacritics folded). No embeddings yet.

## 5. API
- `GET /api/ai/agents?context=`, `GET|POST /api/ai/conversations`, `GET|DELETE /api/ai/conversations/:id`, `POST /api/ai/conversations/:id/messages` (server-sent events: meta, delta, tool, done, error), `POST /api/ai/conversations/:id/score`.
- `ai.manage`: `/api/ai/admin/settings` (GET, PUT), `/admin/keys/:provider` (PUT, DELETE), `POST /admin/keys/:provider/test`, `PATCH /admin/documents/:id` (title, product code), `/admin/agents` (CRUD), `/admin/kbs` (CRUD), `/admin/kbs/:id/documents` (GET, POST), `DELETE /admin/documents/:id`, `GET /admin/search?q=`, `GET /admin/usage?month=`.
- Screen "Trợ lý AI" (`/settings/ai`): tabs Trợ lý, Kho kiến thức, Mô hình và hạn mức, Sử dụng.

## 6. Next steps
- Put real content in: product terms per product (with product code), underwriting rules, service procedures, objection handbook (SALES).
- Enter the keys (per GA, or platform secrets) and check the model ids with each provider; set the monthly budget. Set a dedicated `AI_KEYS_SECRET` before GAs enter keys, so rotating `BETTER_AUTH_SECRET` does not lose them.
- Evaluate answers on real (pseudonymised) cases before rollout; tune the GA instructions.
- Later: DLVN-wide knowledge shared across GAs (Platform Admin), embeddings (Workers AI / Vectorize) if keyword search misses, F2.6/F7 signals in the context, manager view of practice scores (needs a PO decision on privacy).
