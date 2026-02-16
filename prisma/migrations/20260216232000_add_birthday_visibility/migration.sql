-- Add per-user birthday display/privacy setting.
CREATE TYPE "BirthdayVisibility" AS ENUM ('none', 'monthDay', 'full');

ALTER TABLE "User"
ADD COLUMN "birthdayVisibility" "BirthdayVisibility" NOT NULL DEFAULT 'monthDay';

