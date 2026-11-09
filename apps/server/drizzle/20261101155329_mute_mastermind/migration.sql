CREATE TABLE `audioGarbage` (
	`key` text PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `audioUpload` (
	`id` text PRIMARY KEY,
	`folderId` integer NOT NULL,
	`filename` text NOT NULL,
	`requiredFiles` text NOT NULL,
	`uploadedFiles` text DEFAULT '[]' NOT NULL,
	`metadata` text NOT NULL,
	`keyPrefix` text NOT NULL,
	`hash` text NOT NULL,
	`lyricsHash` text,
	`createdAt` integer NOT NULL,
	`committed` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_audioUpload_folderId_folder_id_fk` FOREIGN KEY (`folderId`) REFERENCES `folder`(`id`)
);
--> statement-breakpoint
CREATE TABLE `audio` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`folderId` integer NOT NULL,
	`filename` text NOT NULL,
	`metadata` text NOT NULL,
	`updating` integer DEFAULT 0 NOT NULL,
	`keyPrefix` text NOT NULL,
	`hash` text NOT NULL,
	`lyricsHash` text,
	CONSTRAINT `fk_audio_folderId_folder_id_fk` FOREIGN KEY (`folderId`) REFERENCES `folder`(`id`)
);
--> statement-breakpoint
CREATE TABLE `folder` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pendingSongUpload` ON `audioUpload` (`folderId`,substr("filename", 1, length("filename") - 4)) WHERE "audioUpload"."committed" = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `audioIndex` ON `audio` (`folderId`,substr("filename", 1, length("filename") - 4));