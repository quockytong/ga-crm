CREATE TABLE `client_family` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_code` text NOT NULL,
	`related_client_code` text,
	`full_name` text,
	`birth_year` integer,
	`gender` text,
	`relation` text NOT NULL,
	`note` text,
	`lead_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `client_family_client_idx` ON `client_family` (`tenant_id`,`client_code`);--> statement-breakpoint
CREATE INDEX `client_family_related_idx` ON `client_family` (`tenant_id`,`related_client_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `client_family_pair_idx` ON `client_family` (`tenant_id`,`client_code`,`related_client_code`);--> statement-breakpoint
CREATE TABLE `products` (
	`product_code` text PRIMARY KEY NOT NULL,
	`product_name` text NOT NULL,
	`product_role` text,
	`category` text,
	`min_entry_age` text,
	`max_entry_age` text,
	`max_cover_age` text,
	`gender` text,
	`waiting_period` text,
	`key_benefits` text,
	`fit_rule` text,
	`trigger_event` text,
	`rule_status` text,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crm_activities_client_idx` ON `crm_activities` (`tenant_id`,`client_code`,`occurred_at`);