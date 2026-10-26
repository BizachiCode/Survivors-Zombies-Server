CREATE TABLE `chat_messages` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`channel` varchar(80) NOT NULL,
	`message_id` int unsigned NOT NULL,
	`user_id` varchar(16) NOT NULL,
	`nickname` varchar(64) NOT NULL,
	`avatar_id` varchar(64) NOT NULL,
	`level` int unsigned NOT NULL,
	`text` varchar(1024) NOT NULL,
	`system` boolean NOT NULL,
	`text_key` varchar(128),
	`args` json,
	`at_unix` int unsigned NOT NULL,
	CONSTRAINT `chat_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_chat_messages_channel_message` UNIQUE(`channel`,`message_id`)
);
