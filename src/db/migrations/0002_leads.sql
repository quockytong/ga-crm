CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'OTHER' NOT NULL,
	`channel` text,
	`start_date` text,
	`end_date` text,
	`budget_vnd` integer,
	`owner_user_id` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_name_uq` ON `campaigns` (`tenant_id`,`name`);--> statement-breakpoint
CREATE TABLE `crm_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`agent_code` text,
	`lead_id` text,
	`client_code` text,
	`type` text NOT NULL,
	`outcome` text,
	`note` text,
	`occurred_at` text NOT NULL,
	`due_at` text,
	`done_at` text,
	`source` text DEFAULT 'APP' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `crm_activities_lead_idx` ON `crm_activities` (`tenant_id`,`lead_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `lead_history` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`note` text,
	`import_id` text,
	`changed_by` text NOT NULL,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lead_history_lead_idx` ON `lead_history` (`tenant_id`,`lead_id`,`changed_at`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`external_id` text,
	`full_name` text NOT NULL,
	`name_norm` text NOT NULL,
	`phone` text NOT NULL,
	`email` text,
	`gender` text,
	`age` integer,
	`age_band` text,
	`province` text,
	`region` text,
	`need` text,
	`source` text NOT NULL,
	`phone_source` text,
	`campaign_id` text,
	`lead_date` text NOT NULL,
	`registered_at` text,
	`product_interest` text,
	`product_secondary` text,
	`value_vnd` integer,
	`ref_link` text,
	`extra_info` text,
	`stage` text DEFAULT 'NEW' NOT NULL,
	`interest` text,
	`care_status` text,
	`lost_reason` text,
	`progress_note` text,
	`message_status` text,
	`assigned_agent_code` text,
	`assigned_by` text,
	`assigned_at` text,
	`assignee_seen_at` text,
	`first_contact_at` text,
	`last_contact_at` text,
	`next_action_at` text,
	`consent_marketing` integer DEFAULT false NOT NULL,
	`consent_at` text,
	`consent_source` text,
	`client_code` text,
	`application_no` text,
	`link_status` text DEFAULT 'NONE' NOT NULL,
	`linked_by` text,
	`linked_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_import_id` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_phone_uq` ON `leads` (`tenant_id`,`phone`);--> statement-breakpoint
CREATE INDEX `leads_assignee_idx` ON `leads` (`tenant_id`,`assigned_agent_code`);--> statement-breakpoint
CREATE INDEX `leads_date_idx` ON `leads` (`tenant_id`,`lead_date`);--> statement-breakpoint
-- Lead permissions for Admin and Marketing in existing tenants (DEFAULT_GRANTS in src/shared/permissions.ts).
INSERT OR IGNORE INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'ADMIN', 'leads.manage' FROM `tenants`;
--> statement-breakpoint
INSERT OR IGNORE INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'ADMIN', 'leads.import' FROM `tenants`;
--> statement-breakpoint
INSERT OR IGNORE INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'MARKETING', 'leads.manage' FROM `tenants`;
--> statement-breakpoint
INSERT OR IGNORE INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'MARKETING', 'leads.import' FROM `tenants`;
