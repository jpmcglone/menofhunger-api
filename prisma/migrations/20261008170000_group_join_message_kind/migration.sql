-- A group's #general records each new member as a system row (no body, no attachments).
ALTER TYPE "MessageKind" ADD VALUE 'groupJoin';
