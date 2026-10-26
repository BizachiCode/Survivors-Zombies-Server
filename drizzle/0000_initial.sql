CREATE TABLE `audit_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` char(36),
	`kind` varchar(32) NOT NULL,
	`meta` json,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_devices` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`device_hash` char(64) NOT NULL,
	`platform` varchar(32),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_seen_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_devices_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_user_devices_hash` UNIQUE(`device_hash`)
);
--> statement-breakpoint
CREATE TABLE `user_profile` (
	`user_id` char(36) NOT NULL,
	`nickname` varchar(24) NOT NULL,
	`avatar_id` varchar(64) NOT NULL DEFAULT 'avatar_zombie',
	`level` int NOT NULL DEFAULT 1,
	`exp` bigint NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_profile_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_refresh_tokens` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`device_key` varchar(64) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`issued_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_used_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expires_at` datetime NOT NULL,
	`is_revoked` boolean NOT NULL DEFAULT false,
	`ip` varchar(45),
	`user_agent` varchar(255),
	CONSTRAINT `user_refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_urt_user_device` UNIQUE(`user_id`,`device_key`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`email` varchar(255),
	`password_hash` varchar(255),
	`is_guest` boolean NOT NULL DEFAULT true,
	`failed_logins` int NOT NULL DEFAULT 0,
	`locked_until` datetime,
	`is_banned` boolean NOT NULL DEFAULT false,
	`ban_reason` varchar(255),
	`ban_expires_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`last_login_at` datetime,
	`password_changed_at` datetime,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_users_email` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `currency_ledger` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`currency_id` varchar(32) NOT NULL,
	`delta` bigint NOT NULL,
	`balance_after` bigint NOT NULL,
	`reason` varchar(32) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `currency_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_currencies` (
	`user_id` char(36) NOT NULL,
	`currency_id` varchar(32) NOT NULL,
	`amount` bigint NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_currencies_user_id_currency_id_pk` PRIMARY KEY(`user_id`,`currency_id`)
);
--> statement-breakpoint
CREATE TABLE `battle_results` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`mode` varchar(16) NOT NULL DEFAULT 'campaign',
	`stage_id` varchar(64) NOT NULL,
	`outcome` varchar(16) NOT NULL,
	`stars` int NOT NULL,
	`ticks` int NOT NULL,
	`kills` int NOT NULL,
	`base_health` int NOT NULL,
	`content_hash` char(64) NOT NULL,
	`reward` json NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `battle_results_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_stage_progress` (
	`user_id` char(36) NOT NULL,
	`stage_id` varchar(64) NOT NULL,
	`best_stars` int NOT NULL DEFAULT 0,
	`wins` int NOT NULL DEFAULT 0,
	`plays` int NOT NULL DEFAULT 0,
	`best_time_ms` int,
	`first_cleared_at` datetime,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_stage_progress_user_id_stage_id_pk` PRIMARY KEY(`user_id`,`stage_id`)
);
--> statement-breakpoint
CREATE TABLE `item_ledger` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`item_id` varchar(64) NOT NULL,
	`delta` bigint NOT NULL,
	`balance_after` bigint NOT NULL,
	`reason` varchar(32) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `item_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_cards` (
	`user_id` char(36) NOT NULL,
	`card_id` varchar(64) NOT NULL,
	`level` int NOT NULL DEFAULT 1,
	`source` varchar(16) NOT NULL,
	`unlocked_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_cards_user_id_card_id_pk` PRIMARY KEY(`user_id`,`card_id`)
);
--> statement-breakpoint
CREATE TABLE `user_decks` (
	`user_id` char(36) NOT NULL,
	`cards` json NOT NULL,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_decks_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_items` (
	`user_id` char(36) NOT NULL,
	`item_id` varchar(64) NOT NULL,
	`amount` bigint NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_items_user_id_item_id_pk` PRIMARY KEY(`user_id`,`item_id`)
);
--> statement-breakpoint
CREATE TABLE `shop_purchases` (
	`user_id` char(36) NOT NULL,
	`offer_id` varchar(64) NOT NULL,
	`day` char(10) NOT NULL,
	`count` int NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `shop_purchases_user_id_offer_id_day_pk` PRIMARY KEY(`user_id`,`offer_id`,`day`)
);
--> statement-breakpoint
CREATE TABLE `user_daily_rewards` (
	`user_id` char(36) NOT NULL,
	`step` int NOT NULL DEFAULT 0,
	`last_claim_day` char(10),
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_daily_rewards_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_objectives` (
	`user_id` char(36) NOT NULL,
	`objective_id` varchar(64) NOT NULL,
	`period` varchar(80) NOT NULL,
	`progress` bigint NOT NULL DEFAULT 0,
	`claimed_at` datetime,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_objectives_user_id_objective_id_period_pk` PRIMARY KEY(`user_id`,`objective_id`,`period`)
);
--> statement-breakpoint
CREATE TABLE `user_mail` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`broadcast_id` varchar(64),
	`sender` varchar(64) NOT NULL,
	`title` json NOT NULL,
	`body` json NOT NULL,
	`attachments` json NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expires_at` datetime,
	`read_at` datetime,
	`claimed_at` datetime,
	`deleted_at` datetime,
	CONSTRAINT `user_mail_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_user_mail_broadcast` UNIQUE(`user_id`,`broadcast_id`)
);
--> statement-breakpoint
CREATE TABLE `iap_purchases` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`store` varchar(16) NOT NULL,
	`transaction_key` char(64) NOT NULL,
	`transaction_id` varchar(512) NOT NULL,
	`order_id` varchar(128) NOT NULL DEFAULT '',
	`product_id` varchar(64) NOT NULL,
	`store_product_id` varchar(150) NOT NULL DEFAULT '',
	`environment` varchar(16) NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`granted` json NOT NULL,
	`purchased_at` datetime NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'granted',
	`refunded_at` datetime,
	`refund_reason` varchar(255),
	`refund_shortfall` json,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `iap_purchases_id` PRIMARY KEY(`id`),
	CONSTRAINT `iap_purchases_transaction` UNIQUE(`store`,`transaction_key`)
);
--> statement-breakpoint
CREATE TABLE `wheel_spins` (
	`user_id` char(36) NOT NULL,
	`day` char(10) NOT NULL,
	`spins` int NOT NULL DEFAULT 0,
	`free_spins` int NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `wheel_spins_user_id_day_pk` PRIMARY KEY(`user_id`,`day`)
);
--> statement-breakpoint
CREATE TABLE `friend_gifts` (
	`id` char(36) NOT NULL,
	`from_user_id` char(36) NOT NULL,
	`to_user_id` char(36) NOT NULL,
	`sent_day` char(10) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`claimed_at` datetime,
	`claimed_day` varchar(10),
	CONSTRAINT `friend_gifts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_friend_gifts_daily` UNIQUE(`from_user_id`,`to_user_id`,`sent_day`)
);
--> statement-breakpoint
CREATE TABLE `friend_requests` (
	`pair_key` char(73) NOT NULL,
	`from_user_id` char(36) NOT NULL,
	`to_user_id` char(36) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `friend_requests_pair_key` PRIMARY KEY(`pair_key`)
);
--> statement-breakpoint
CREATE TABLE `user_friendships` (
	`user_a` char(36) NOT NULL,
	`user_b` char(36) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_friendships_user_a_user_b_pk` PRIMARY KEY(`user_a`,`user_b`)
);
--> statement-breakpoint
CREATE TABLE `arena_entries` (
	`season_id` char(10) NOT NULL,
	`user_id` char(36) NOT NULL,
	`group_id` char(36) NOT NULL,
	`league_index` int NOT NULL,
	`best_score` int NOT NULL DEFAULT 0,
	`best_at` datetime(3),
	`plays` int NOT NULL DEFAULT 0,
	`settled_at` datetime,
	CONSTRAINT `arena_entries_season_id_user_id_pk` PRIMARY KEY(`season_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `arena_groups` (
	`id` char(36) NOT NULL,
	`season_id` char(10) NOT NULL,
	`league_index` int NOT NULL,
	`members` int NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `arena_groups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `arena_players` (
	`user_id` char(36) NOT NULL,
	`league_index` int NOT NULL DEFAULT 0,
	`tickets` int NOT NULL,
	`tickets_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `arena_players_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `admin_audit` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`ip` varchar(45) NOT NULL DEFAULT '',
	`action` varchar(48) NOT NULL,
	`target` varchar(128) NOT NULL DEFAULT '',
	`payload` json NOT NULL,
	CONSTRAINT `admin_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `server_settings` (
	`key` varchar(64) NOT NULL,
	`value` varchar(512) NOT NULL,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `server_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `clan_donation_requests` (
	`id` char(36) NOT NULL,
	`clan_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`item_id` varchar(64) NOT NULL,
	`requested` int NOT NULL,
	`received` int NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `clan_donation_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `clan_donations` (
	`id` char(36) NOT NULL,
	`request_id` char(36) NOT NULL,
	`donor_id` char(36) NOT NULL,
	`day` char(10) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `clan_donations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `clan_join_requests` (
	`user_id` char(36) NOT NULL,
	`clan_id` char(36) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `clan_join_requests_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `clan_members` (
	`user_id` char(36) NOT NULL,
	`clan_id` char(36) NOT NULL,
	`role` varchar(12) NOT NULL,
	`joined_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `clan_members_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `clans` (
	`id` char(36) NOT NULL,
	`tag` char(6) NOT NULL,
	`name` varchar(20) NOT NULL,
	`name_key` varchar(20) NOT NULL,
	`description` varchar(140) NOT NULL DEFAULT '',
	`badge` varchar(16) NOT NULL,
	`type` varchar(10) NOT NULL,
	`min_level` int NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `clans_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_clans_tag` UNIQUE(`tag`),
	CONSTRAINT `uq_clans_name_key` UNIQUE(`name_key`)
);
--> statement-breakpoint
CREATE TABLE `tower_progress` (
	`user_id` char(36) NOT NULL,
	`tower_id` varchar(64) NOT NULL,
	`highest_cleared` int NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tower_progress_user_id_tower_id_pk` PRIMARY KEY(`user_id`,`tower_id`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD CONSTRAINT `audit_events_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_devices` ADD CONSTRAINT `user_devices_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_profile` ADD CONSTRAINT `user_profile_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_refresh_tokens` ADD CONSTRAINT `user_refresh_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `currency_ledger` ADD CONSTRAINT `currency_ledger_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_currencies` ADD CONSTRAINT `user_currencies_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `battle_results` ADD CONSTRAINT `battle_results_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_stage_progress` ADD CONSTRAINT `user_stage_progress_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_ledger` ADD CONSTRAINT `item_ledger_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_cards` ADD CONSTRAINT `user_cards_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_decks` ADD CONSTRAINT `user_decks_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_items` ADD CONSTRAINT `user_items_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shop_purchases` ADD CONSTRAINT `shop_purchases_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_daily_rewards` ADD CONSTRAINT `user_daily_rewards_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_objectives` ADD CONSTRAINT `user_objectives_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_mail` ADD CONSTRAINT `user_mail_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `iap_purchases` ADD CONSTRAINT `iap_purchases_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wheel_spins` ADD CONSTRAINT `wheel_spins_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `friend_gifts` ADD CONSTRAINT `friend_gifts_from_user_id_users_id_fk` FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `friend_gifts` ADD CONSTRAINT `friend_gifts_to_user_id_users_id_fk` FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `friend_requests` ADD CONSTRAINT `friend_requests_from_user_id_users_id_fk` FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `friend_requests` ADD CONSTRAINT `friend_requests_to_user_id_users_id_fk` FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_friendships` ADD CONSTRAINT `user_friendships_user_a_users_id_fk` FOREIGN KEY (`user_a`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_friendships` ADD CONSTRAINT `user_friendships_user_b_users_id_fk` FOREIGN KEY (`user_b`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `arena_entries` ADD CONSTRAINT `arena_entries_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `arena_players` ADD CONSTRAINT `arena_players_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clan_donation_requests` ADD CONSTRAINT `clan_donation_requests_clan_id_clans_id_fk` FOREIGN KEY (`clan_id`) REFERENCES `clans`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clan_donation_requests` ADD CONSTRAINT `clan_donation_requests_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clan_donations` ADD CONSTRAINT `clan_donations_request_id_clan_donation_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `clan_donation_requests`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clan_donations` ADD CONSTRAINT `clan_donations_donor_id_users_id_fk` FOREIGN KEY (`donor_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clan_join_requests` ADD CONSTRAINT `clan_join_requests_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clan_join_requests` ADD CONSTRAINT `clan_join_requests_clan_id_clans_id_fk` FOREIGN KEY (`clan_id`) REFERENCES `clans`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clan_members` ADD CONSTRAINT `clan_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `clan_members` ADD CONSTRAINT `clan_members_clan_id_clans_id_fk` FOREIGN KEY (`clan_id`) REFERENCES `clans`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tower_progress` ADD CONSTRAINT `tower_progress_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_audit_user` ON `audit_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_user_devices_user` ON `user_devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_profile_level` ON `user_profile` (`level`,`exp`);--> statement-breakpoint
CREATE INDEX `idx_urt_expiry` ON `user_refresh_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_users_last_login` ON `users` (`last_login_at`);--> statement-breakpoint
CREATE INDEX `idx_users_ban` ON `users` (`is_banned`,`ban_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_ledger_user` ON `currency_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_battle_results_user` ON `battle_results` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_item_ledger_user` ON `item_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_user_mail_user` ON `user_mail` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `iap_purchases_user_product` ON `iap_purchases` (`user_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `iap_purchases_created` ON `iap_purchases` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_friend_gifts_inbox` ON `friend_gifts` (`to_user_id`,`claimed_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_friend_gifts_claimed_day` ON `friend_gifts` (`to_user_id`,`claimed_day`);--> statement-breakpoint
CREATE INDEX `idx_friend_requests_from` ON `friend_requests` (`from_user_id`);--> statement-breakpoint
CREATE INDEX `idx_friend_requests_to` ON `friend_requests` (`to_user_id`);--> statement-breakpoint
CREATE INDEX `idx_friend_requests_created` ON `friend_requests` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_friendships_b` ON `user_friendships` (`user_b`);--> statement-breakpoint
CREATE INDEX `arena_entries_group` ON `arena_entries` (`group_id`,`best_score`);--> statement-breakpoint
CREATE INDEX `arena_entries_user` ON `arena_entries` (`user_id`,`settled_at`);--> statement-breakpoint
CREATE INDEX `arena_groups_open` ON `arena_groups` (`season_id`,`league_index`,`members`);--> statement-breakpoint
CREATE INDEX `idx_admin_audit_target` ON `admin_audit` (`target`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admin_audit_created` ON `admin_audit` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_clan_donation_requests_clan` ON `clan_donation_requests` (`clan_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_clan_donation_requests_user` ON `clan_donation_requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_clan_donations_request` ON `clan_donations` (`request_id`,`donor_id`);--> statement-breakpoint
CREATE INDEX `idx_clan_donations_day` ON `clan_donations` (`donor_id`,`day`);--> statement-breakpoint
CREATE INDEX `idx_clan_join_requests_clan` ON `clan_join_requests` (`clan_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_clan_members_clan` ON `clan_members` (`clan_id`,`joined_at`);--> statement-breakpoint
CREATE INDEX `idx_clans_type` ON `clans` (`type`);