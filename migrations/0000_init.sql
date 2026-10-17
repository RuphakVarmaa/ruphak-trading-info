CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`published_ms` integer NOT NULL,
	`ingested_ms` integer NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `articles_published` ON `articles` (`published_ms`);--> statement-breakpoint
CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_ts` ON `audit` (`ts`);--> statement-breakpoint
CREATE TABLE `clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text,
	`status` text NOT NULL,
	`first_seen_ms` integer NOT NULL,
	`last_seen_ms` integer NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clusters_last_seen` ON `clusters` (`last_seen_ms`);--> statement-breakpoint
CREATE INDEX `clusters_status` ON `clusters` (`status`,`last_seen_ms`);--> statement-breakpoint
CREATE INDEX `clusters_key` ON `clusters` (`key`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`index_id` text NOT NULL,
	`t` integer NOT NULL,
	`stance` text NOT NULL,
	`has_plan` integer NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decisions_t` ON `decisions` (`t`);--> statement-breakpoint
CREATE INDEX `decisions_index_t` ON `decisions` (`index_id`,`t`);--> statement-breakpoint
CREATE TABLE `event_scores` (
	`cluster_id` text PRIMARY KEY NOT NULL,
	`cluster_key` text NOT NULL,
	`first_seen_ms` integer NOT NULL,
	`scored_at_ms` integer NOT NULL,
	`scorer` text NOT NULL,
	`taxonomy` text NOT NULL,
	`nifty_numeric` real NOT NULL,
	`sensex_numeric` real NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_scores_first_seen` ON `event_scores` (`first_seen_ms`);--> statement-breakpoint
CREATE INDEX `event_scores_scored_at` ON `event_scores` (`scored_at_ms`);--> statement-breakpoint
CREATE TABLE `fills` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`t` integer NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fills_order` ON `fills` (`order_id`);--> statement-breakpoint
CREATE INDEX `fills_t` ON `fills` (`t`);--> statement-breakpoint
CREATE TABLE `heartbeat` (
	`id` integer PRIMARY KEY NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kv_state` (
	`key` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`updated_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ledger` (
	`mode` text NOT NULL,
	`date` text NOT NULL,
	`json` text NOT NULL,
	PRIMARY KEY(`mode`, `date`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`ref_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`created_ms` integer NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_ref` ON `orders` (`ref_id`);--> statement-breakpoint
CREATE INDEX `orders_mode_status` ON `orders` (`mode`,`status`);--> statement-breakpoint
CREATE INDEX `orders_created` ON `orders` (`created_ms`);--> statement-breakpoint
CREATE TABLE `outcomes` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`t` integer NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outcomes_t` ON `outcomes` (`t`);--> statement-breakpoint
CREATE TABLE `performance` (
	`mode` text NOT NULL,
	`source` text NOT NULL,
	`index_id` text NOT NULL,
	`json` text NOT NULL,
	PRIMARY KEY(`mode`, `source`, `index_id`)
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`t` integer NOT NULL,
	`index_id` text NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`index_id` text NOT NULL,
	`exit_ms` integer,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `positions_mode_status` ON `positions` (`mode`,`status`);--> statement-breakpoint
CREATE INDEX `positions_exit` ON `positions` (`mode`,`exit_ms`);--> statement-breakpoint
CREATE TABLE `pressure` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`index_id` text NOT NULL,
	`t` integer NOT NULL,
	`epi` real NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pressure_index_t` ON `pressure` (`index_id`,`t`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`t` integer PRIMARY KEY NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`position_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`exit_ms` integer NOT NULL,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trades_mode_exit` ON `trades` (`mode`,`exit_ms`);