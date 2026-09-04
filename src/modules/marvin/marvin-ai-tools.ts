/**
 * Local function tools registered on every Marv Responses request.
 *
 * The Stored Prompt should list the same names for documentation, but in-code
 * registration is the source of truth — a drifted prompt cannot drop a tool.
 * Hosted `web_search` is added separately when the mode is allowed to search.
 */

export const MARV_LOCAL_TOOL_NAMES = [
  'fetch_url_content',
  'get_bible_passage',
  'get_user_basic_info',
  'get_user_context_card',
  'get_post',
  'list_public_posts',
  'get_post_thread_recent_messages',
  'get_post_thread_summary',
  'get_my_recent_chat_messages',
  'find_similar_members',
  'find_members_by_name',
] as const;

export type MarvLocalToolName = (typeof MARV_LOCAL_TOOL_NAMES)[number];

export const MARV_LOCAL_FUNCTION_TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    type: 'function',
    name: 'fetch_url_content',
    description:
      'Fetch and read the full text content of a web page. Use this when the user or conversation contains a URL and you need to understand what the page says before responding. Only fetch URLs that are directly relevant to your reply.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch, starting with http:// or https://.',
        },
      },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'get_bible_passage',
    description:
      'Look up the exact text of a Bible passage by reference (non-AI lookup). Use ONLY when the user asks for Scripture or a specific verse/passage. Do not volunteer Scripture unprompted.',
    parameters: {
      type: 'object',
      properties: {
        reference: {
          type: 'string',
          description:
            'A scripture reference such as "John 3:16", "Romans 8:28-30", "Rom 9", or "Eph 2:1,8".',
        },
      },
      required: ['reference'],
    },
  },
  {
    type: 'function',
    name: 'get_user_basic_info',
    description:
      'Look up a platform member by @username and return tier, join date, and display name. Use when you need a quick identity check.',
    parameters: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'Platform username, with or without a leading @.',
        },
      },
      required: ['username'],
    },
  },
  {
    type: 'function',
    name: 'get_user_context_card',
    description:
      'Look up a platform member by @username and return their public profile card (bio, interests, public-post summary). Use when the question is about who they are.',
    parameters: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'Platform username, with or without a leading @.',
        },
      },
      required: ['username'],
    },
  },
  {
    type: 'function',
    name: 'get_post',
    description:
      'Load one post by id (body, author, media, poll, check-in). Use when a post id is referenced and you do not already have the text.',
    parameters: {
      type: 'object',
      properties: {
        postId: {
          type: 'string',
          description: 'The post id to load.',
        },
      },
      required: ['postId'],
    },
  },
  {
    type: 'function',
    name: 'list_public_posts',
    description:
      'List recent public lodge posts (not group-only). For the general lodge feed, call with only limit (or no arguments). Do not put a placeholder in username. Pass username only when the question is about one member. Returns text, media, polls, and check-ins.',
    parameters: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description:
            'Member @username when the question is about that person. Leave this field off for the general lodge feed.',
        },
        limit: {
          type: 'integer',
          description: 'Max posts to return (1–8). Default 5.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_post_thread_recent_messages',
    description:
      'Read recent messages in a public thread by root post id. Use when you need more thread context than the developer note already provided.',
    parameters: {
      type: 'object',
      properties: {
        rootPostId: {
          type: 'string',
          description: 'The root (ancestor) post id of the thread.',
        },
        limit: {
          type: 'integer',
          description: 'Max messages to return (1–30). Default 10.',
        },
      },
      required: ['rootPostId'],
    },
  },
  {
    type: 'function',
    name: 'get_post_thread_summary',
    description:
      'Load the rolling summary of a public thread by root post id, if one exists.',
    parameters: {
      type: 'object',
      properties: {
        rootPostId: {
          type: 'string',
          description: 'The root (ancestor) post id of the thread.',
        },
      },
      required: ['rootPostId'],
    },
  },
  {
    type: 'function',
    name: 'get_my_recent_chat_messages',
    description:
      'Retrieve recent messages from this private Marv conversation. Use in DMs when you need earlier turns that are not already in context.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Max messages to return (1–30). Default 10.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'find_similar_members',
    description:
      'Find platform members similar to the requester or matching a short interest/query (interests + public profile cards). Use when the user asks who they should meet or if anyone else is into a topic.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional short topic or interest (e.g. "woodworking", "Texas", "fasting"). Omit to match the requester\'s own interests/profile.',
        },
        limit: {
          type: 'integer',
          description: 'Max members to return (1–8). Default 5.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'find_members_by_name',
    description:
      'Last resort: resolve a first name, last name, or display name to platform @usernames. Do not call this if "People in this conversation" already has a match — "John" there is that John. Use only when the name is not in this conversation.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'First name, last name, or full display name (e.g. "Tim", "McGlone", "John Smith").',
        },
        limit: {
          type: 'integer',
          description: 'Max matches to return (1–8). Default 5.',
        },
      },
      required: ['name'],
    },
  },
];
