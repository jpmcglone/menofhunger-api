-- Add optional email to User
ALTER TABLE "User"
ADD COLUMN "email" TEXT;

-- Unique index (Postgres allows multiple NULLs)
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

