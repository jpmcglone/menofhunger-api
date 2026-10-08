# Marv scoped memory

Member replies can recall relevant source statements from MoH. The current question
and conversation remain primary; memory is an optional tool, not the live public
briefing. This is a source index with author/topic metadata, not neural-network
training or generated personality summaries.

## Public briefing

Every member-facing reply (a public thread, a DM, and a group channel) includes a
short live briefing of public posts, published articles, and Board threads. Marv
answers what is happening on public Men of Hunger from that briefing. He does not
say he does not know. Inside a group, the same briefing adds that group's feed
posts and recent messages from channels he can see. A private channel's messages
appear only in a reply inside that channel. Personal memory stays off in channel
replies. The briefing is loaded live for the reply; it is not the memory index.

## Boundaries

| Source | Where it can be recalled |
| --- | --- |
| Published public posts outside groups | Any authorized member reply |
| Group posts, including normal verified-only group posts | That exact group |
| Other restricted posts | Their exact root thread |
| Human private messages | Their exact conversation |

Private and group evidence cannot become public memory through summaries or inferred
facts: no generated summaries or bot outputs are written to the index. Each record
contains one source ID, its original scope, and its first-learned timestamp. Repeated
observations preserve both scope and timestamp. If a source moves between scopes,
its old record becomes ineligible rather than being promoted. More restrictive
branches cannot be recalled into a broader root's reply audience.

Recall derives identity and scope from the trusted reply job, never model-supplied
IDs. It checks current conversation acceptance or active group membership, current
post access, visibility and ancestry, blocks, bans, drafts, and deletions. Group
membership is required even for administrators. Private message queries also honor
the requester's per-message deletions. Source text is loaded live; hard deletion
cascades to the index and soft deletion excludes the source. An edit is reflected
on the next recall without resetting first-learned time.

## Learning and relevance

After the requester's AI permission check, reply preparation observes at most 40
previously unseen public root posts, 60 posts in the current thread, 30 unseen root
posts in the current group, and 30 recent messages in the current private chat.
Learning happens as member replies are processed; there is no continuous crawler or
upfront backfill. Publication time and first-learned time are distinct.

The model can call `recall_relevant_memory` when context helps answer the current
request. The tool takes no arguments. The server searches using the actual current
question and authorized scopes. Ordinary recall requires at least two significant
matching words and 40% query coverage. Only eligible matches receive a small recency
boost, decaying with a seven-day half-life. A recent unrelated post cannot pass this
gate. Explicit requests for what is new in the MoH community can retrieve a public
overview without term overlap.

Recall considers up to 80 matching observations, checks the top 16 candidates, and
returns up to four attributed snippets of 1,100 characters with source IDs, author,
topics, publication/edit dates, and learned time. This conservative lexical first
version may miss synonyms or vague references; it does not claim semantic recall.
The prompt treats retrieved statements as untrusted evidence and requires each
memory reference to help answer the current request.

Private replies rebuild their recent history from live messages (up to 30 messages,
800 characters each), instead of chaining earlier OpenAI response IDs across member
turns. Tool follow-ups within a turn still use the normal response chain. Older
human messages become recallable after observation. Admin and shared-content
background runs do not collect or retrieve this memory. Optional indexing/retrieval
failures permit a reply without memory.

## Validation and deployment

Run the focused memory, AI-service, public/private reply processor, and system-prompt
Jest suites, changed-file lint, typecheck, contract checks, and the production build.
`bash scripts/check-marvin-memory.sh` applies the actual migration to an isolated
PostgreSQL 16 container and verifies source/scope constraints, duplicate observation
behavior, preserved learned time, and post/message deletion cascades. It never uses
`DATABASE_URL` and cleans up its own container.

The additive `20260928140000_marvin_scoped_memory` migration must run before release.
The existing Render API service runs `npm run prisma:migrate:deploy` in pre-deploy.
No environment variables, client contracts, web release, or iOS binary update are
required. Rollback can leave the unused source-index table in place.

Automated reply tests mock the model: they verify routing, boundaries and prompt
construction, not a guarantee about every live model's phrasing.
