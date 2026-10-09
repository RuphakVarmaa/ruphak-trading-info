CREATE TABLE `bars_5m` (
	`symbol` text NOT NULL,
	`t` integer NOT NULL,
	`o` real NOT NULL,
	`h` real NOT NULL,
	`l` real NOT NULL,
	`c` real NOT NULL,
	`v` integer NOT NULL,
	`oi` integer,
	`source` text NOT NULL,
	`first_seen_ms` integer NOT NULL,
	PRIMARY KEY(`symbol`, `t`)
);
