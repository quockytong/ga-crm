CREATE TABLE `ai_provider_keys` (
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`last4` text NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `provider`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
