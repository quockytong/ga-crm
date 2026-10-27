CREATE TABLE `lead_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lead_comments_lead_idx` ON `lead_comments` (`tenant_id`,`lead_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `success_activities` (
	`tenant_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`agent_code` text NOT NULL,
	`leader_code` text,
	`office_code` text,
	`program_code` text,
	`program_month` integer,
	`activity_type` text NOT NULL,
	`sub_activity_title` text,
	`record_mode` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_seconds` integer,
	`status` text NOT NULL,
	`customer_id` text,
	`customer_name` text,
	`customer_phone` text,
	`activity_method` text,
	`call_type` text,
	`call_outcome` text,
	`call_phone_hash` text,
	`content_note` text,
	`location_name` text,
	`activity_date` text NOT NULL,
	`phone_key` text,
	`last_import_id` text,
	`last_seen_at` text,
	PRIMARY KEY(`tenant_id`, `activity_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `success_activities_agent_idx` ON `success_activities` (`tenant_id`,`agent_code`,`activity_date`);--> statement-breakpoint
ALTER TABLE `leads` ADD `assignee_viewed_at` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `last_comment_at` text;--> statement-breakpoint
ALTER TABLE `leads` ADD `last_comment_by` text;