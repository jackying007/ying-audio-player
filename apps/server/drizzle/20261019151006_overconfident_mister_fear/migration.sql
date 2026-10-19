CREATE TABLE `audioGarbage` (
	`key` text PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `audioUploads` (
	`id` text PRIMARY KEY,
	`folderId` integer NOT NULL,
	`filename` text NOT NULL,
	`metadata` text NOT NULL,
	`audioKey` text,
	`lyricsKey` text,
	`coverKey` text,
	`audioHash` text,
	`lyricsHash` text,
	`coverHash` text,
	`createdAt` integer NOT NULL,
	`committed` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_audioUploads_folderId_folders_id_fk` FOREIGN KEY (`folderId`) REFERENCES `folders`(`id`)
);
--> statement-breakpoint
CREATE TABLE `audios` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`folderId` integer NOT NULL,
	`filename` text NOT NULL,
	`metadata` text NOT NULL,
	`version` text NOT NULL,
	`audioKey` text NOT NULL,
	`lyricsKey` text,
	`coverKey` text,
	`audioHash` text,
	`lyricsHash` text,
	`coverHash` text,
	CONSTRAINT `fk_audios_folderId_folders_id_fk` FOREIGN KEY (`folderId`) REFERENCES `folders`(`id`)
);
--> statement-breakpoint
CREATE TABLE `folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audioIndex` ON `audios` (`folderId`,`filename`);