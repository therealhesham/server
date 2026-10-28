-- صندوق إشعارات العميل داخل التطبيق (أيقونة الجرس) — إضافة خالصة، لا تمسّ أي
-- جدول قائم. مطابق لموديل CustomerNotification في schema.prisma.
-- ملاحظة: جدول `Notification` القديم خاص بموظفي لوحة الإدارة (employeeId) ولا
-- علاقة له بالعملاء، فلهذا جدول مستقل.
-- التراجع: DROP TABLE `CustomerNotification`;

CREATE TABLE IF NOT EXISTS `CustomerNotification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body` TEXT NOT NULL,
    `bookingId` INTEGER NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CustomerNotification_userId_isRead_createdAt_idx`(`userId`, `isRead`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
