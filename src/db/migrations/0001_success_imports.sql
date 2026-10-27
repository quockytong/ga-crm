CREATE TABLE `applications` (
	`tenant_id` text NOT NULL,
	`application_no` text NOT NULL,
	`policy_no` text,
	`agent_code` text NOT NULL,
	`client_code` text,
	`holder_name` text NOT NULL,
	`holder_name_norm` text NOT NULL,
	`created_date` text NOT NULL,
	`received_date` text,
	`status` text NOT NULL,
	`issued_date` text,
	`product_code` text,
	`ape_vnd` integer,
	`last_import_id` text,
	`last_seen_at` text,
	PRIMARY KEY(`tenant_id`, `application_no`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `applications_agent_idx` ON `applications` (`tenant_id`,`agent_code`);--> statement-breakpoint
CREATE INDEX `applications_client_idx` ON `applications` (`tenant_id`,`client_code`);--> statement-breakpoint
CREATE TABLE `client_agents` (
	`tenant_id` text NOT NULL,
	`client_code` text NOT NULL,
	`agent_code` text NOT NULL,
	`source` text DEFAULT 'CLIENTS_SHEET' NOT NULL,
	PRIMARY KEY(`tenant_id`, `client_code`, `agent_code`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `client_agents_agent_idx` ON `client_agents` (`tenant_id`,`agent_code`);--> statement-breakpoint
CREATE TABLE `clients` (
	`tenant_id` text NOT NULL,
	`client_code` text NOT NULL,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`tier` text,
	`active_policies` integer,
	`lapsed_policies` integer,
	`dob` text,
	`gender` text,
	`marital_status` text,
	`loyalty_points` integer,
	`uses_dconnect` integer,
	`dconnect_last_login_at` text,
	`id_updated` integer,
	`ekyc_registered` integer,
	`ekyc_registered_at` text,
	`birth_day_month` text,
	`age_band` text,
	`last_import_id` text,
	`last_seen_at` text,
	PRIMARY KEY(`tenant_id`, `client_code`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `clients_name_idx` ON `clients` (`tenant_id`,`name_norm`);--> statement-breakpoint
CREATE TABLE `import_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`sheet` text NOT NULL,
	`row` integer NOT NULL,
	`column` text,
	`code` text NOT NULL,
	`record_key` text,
	`message_vi` text NOT NULL,
	`severity` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_errors_import_idx` ON `import_errors` (`import_id`,`sheet`,`row`);--> statement-breakpoint
CREATE TABLE `import_rows` (
	`import_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`sheet` text NOT NULL,
	`row_no` integer NOT NULL,
	`key` text NOT NULL,
	`owner` text,
	`data` text NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`import_id`, `sheet`, `row_no`),
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_rows_key_idx` ON `import_rows` (`import_id`,`sheet`,`key`);--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_code` text,
	`r2_key` text,
	`file_name` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`status` text NOT NULL,
	`sheet_counts` text NOT NULL,
	`created_at` text NOT NULL,
	`committed_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `imports_tenant_idx` ON `imports` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `imports_user_idx` ON `imports` (`user_id`);--> statement-breakpoint
CREATE TABLE `policies` (
	`tenant_id` text NOT NULL,
	`policy_no` text NOT NULL,
	`holder_client_code` text NOT NULL,
	`insured_client_code` text,
	`servicing_agent_code` text NOT NULL,
	`holder_name` text NOT NULL,
	`holder_name_norm` text NOT NULL,
	`insured_name` text NOT NULL,
	`insured_name_norm` text NOT NULL,
	`status` text NOT NULL,
	`effective_date` text NOT NULL,
	`maturity_date` text NOT NULL,
	`premium_frequency` text NOT NULL,
	`premium_due_date` text,
	`planned_premium_vnd` integer,
	`base_premium_vnd` integer NOT NULL,
	`unpaid_premium_vnd` integer,
	`apl_debt_vnd` integer,
	`has_beneficiary` integer,
	`last_import_id` text,
	`last_seen_at` text,
	PRIMARY KEY(`tenant_id`, `policy_no`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policies_holder_idx` ON `policies` (`tenant_id`,`holder_client_code`);--> statement-breakpoint
CREATE TABLE `policy_agents` (
	`tenant_id` text NOT NULL,
	`policy_no` text NOT NULL,
	`agent_code` text NOT NULL,
	`split_percent` integer,
	`is_servicing` integer DEFAULT false NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`last_import_id` text,
	`last_seen_at` text,
	PRIMARY KEY(`tenant_id`, `policy_no`, `agent_code`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policy_agents_agent_idx` ON `policy_agents` (`tenant_id`,`agent_code`);--> statement-breakpoint
CREATE TABLE `policy_clients` (
	`tenant_id` text NOT NULL,
	`policy_no` text NOT NULL,
	`client_code` text NOT NULL,
	`role` text NOT NULL,
	`source` text NOT NULL,
	`ended_at` text,
	`last_import_id` text,
	`last_seen_at` text,
	PRIMARY KEY(`tenant_id`, `policy_no`, `client_code`, `role`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policy_clients_client_idx` ON `policy_clients` (`tenant_id`,`client_code`);--> statement-breakpoint
CREATE TABLE `policy_products` (
	`tenant_id` text NOT NULL,
	`policy_no` text NOT NULL,
	`product_code` text NOT NULL,
	`insured_code` text DEFAULT '' NOT NULL,
	`product_name` text,
	`product_role` text NOT NULL,
	`sum_assured_vnd` integer,
	`annual_premium_vnd` integer,
	`plan` text,
	`start_date` text,
	`status` text,
	`last_import_id` text,
	`last_seen_at` text,
	PRIMARY KEY(`tenant_id`, `policy_no`, `product_code`, `insured_code`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `record_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_key` text NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`import_id` text,
	`changed_by` text NOT NULL,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `record_changes_entity_idx` ON `record_changes` (`tenant_id`,`entity`,`entity_key`,`changed_at`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`tenant_id` text NOT NULL,
	`role` text NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `role`, `permission`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `manager_fixed` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Default RBAC grants for tenants that already exist (keep in sync with DEFAULT_GRANTS in src/shared/permissions.ts).
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'ADMIN', 'users.manage' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'ADMIN', 'agents.view_all' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'ADMIN', 'agents.edit_tree' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'ADMIN', 'imports.upload' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'ADMIN', 'imports.agent_tree' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'ADMIN', 'imports.view_all' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'MARKETING', 'agents.view_all' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'MARKETING', 'imports.upload' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'MARKETING', 'imports.tenant_wide' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'GAD', 'imports.upload' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'BM', 'imports.upload' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'UM', 'imports.upload' FROM `tenants`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`tenant_id`, `role`, `permission`) SELECT `id`, 'FC', 'imports.upload' FROM `tenants`;
