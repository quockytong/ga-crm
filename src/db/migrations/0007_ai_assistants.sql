CREATE TABLE `ai_agent_knowledge` (
	`tenant_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`kb_id` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `agent_id`, `kb_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ai_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`instructions` text NOT NULL,
	`contexts` text NOT NULL,
	`models` text NOT NULL,
	`task_tiers` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_agents_tenant_idx` ON `ai_agents` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `ai_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kb_id` text NOT NULL,
	`document_id` text NOT NULL,
	`seq` integer NOT NULL,
	`heading` text,
	`body` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_chunks_doc_idx` ON `ai_chunks` (`tenant_id`,`document_id`);--> statement-breakpoint
CREATE TABLE `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`context` text NOT NULL,
	`context_ref` text,
	`title` text NOT NULL,
	`pseudonyms` text NOT NULL,
	`coach` text,
	`score` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_conversations_user_idx` ON `ai_conversations` (`tenant_id`,`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `ai_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kb_id` text NOT NULL,
	`title` text NOT NULL,
	`product_code` text,
	`source_name` text,
	`chars` integer NOT NULL,
	`chunks` integer NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_documents_kb_idx` ON `ai_documents` (`tenant_id`,`kb_id`);--> statement-breakpoint
CREATE TABLE `ai_knowledge_bases` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_kb_tenant_idx` ON `ai_knowledge_bases` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`task` text,
	`provider` text,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`sources` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_messages_conv_idx` ON `ai_messages` (`tenant_id`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_messages_usage_idx` ON `ai_messages` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_settings` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`tiers` text NOT NULL,
	`router` text NOT NULL,
	`monthly_token_limit` integer NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Full-text index over knowledge chunks (diacritics folded, so "bao hiem" finds "bảo hiểm").
CREATE VIRTUAL TABLE `ai_chunks_fts` USING fts5(heading, body, content='ai_chunks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `ai_chunks_fts_insert` AFTER INSERT ON `ai_chunks` BEGIN
  INSERT INTO ai_chunks_fts(rowid, heading, body) VALUES (new.rowid, new.heading, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `ai_chunks_fts_delete` AFTER DELETE ON `ai_chunks` BEGIN
  INSERT INTO ai_chunks_fts(ai_chunks_fts, rowid, heading, body) VALUES ('delete', old.rowid, old.heading, old.body);
END;
--> statement-breakpoint
-- Agents of existing GAs may use the assistants (new GAs get it from DEFAULT_GRANTS).
INSERT OR IGNORE INTO `role_permissions` (`tenant_id`, `role`, `permission`)
  SELECT t.id, r.role, 'ai.use' FROM tenants t CROSS JOIN (SELECT 'GAD' AS role UNION ALL SELECT 'BM' UNION ALL SELECT 'UM' UNION ALL SELECT 'FC') r;
