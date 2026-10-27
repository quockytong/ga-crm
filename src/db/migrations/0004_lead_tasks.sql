CREATE TABLE `lead_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`agent_code` text,
	`title` text NOT NULL,
	`due_at` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`source` text DEFAULT 'APP' NOT NULL,
	`done_at` text,
	`done_by` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lead_tasks_lead_idx` ON `lead_tasks` (`tenant_id`,`lead_id`);--> statement-breakpoint
CREATE INDEX `lead_tasks_agent_idx` ON `lead_tasks` (`tenant_id`,`agent_code`,`status`,`due_at`);--> statement-breakpoint
ALTER TABLE `leads` ADD `dob` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `policy_no` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `origin` text DEFAULT 'GA' NOT NULL;