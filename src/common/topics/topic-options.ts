export type TopicOption = {
  /** Stored value (also what we put in User.interests). */
  value: string;
  /** Human-friendly label. */
  label: string;
  /** Group used by pickers/UI. */
  group: string;
  /** Alternate spellings/phrases that should map to `value`. */
  aliases?: string[];
};

/**
 * Canonical topic allowlist.
 *
 * This is used for:
 * - Explore “Topics” (so we never show garbage tokens like “ipsum”)
 * - Interests picker suggestions (mapping inferred text -> stable values)
 *
 * NOTE: Keep this list in sync with the www app’s interest/topic options.
 */
export const TOPIC_OPTIONS: TopicOption[] = [
  // Fitness (strength)
  {
    value: 'weightlifting',
    label: 'Weightlifting',
    group: 'Fitness',
    aliases: ['oly', 'olympic lifting', 'olympic weightlifting', 'snatch', 'clean and jerk', 'clean & jerk', 'c and j', 'c&j'],
  },
  {
    value: 'powerlifting',
    label: 'Powerlifting',
    group: 'Fitness',
    aliases: ['squat', 'bench', 'deadlift', 'sbd', '1rm', 'pr', 'ipf', 'usapl'],
  },
  {
    value: 'bodybuilding',
    label: 'Bodybuilding',
    group: 'Fitness',
    aliases: ['hypertrophy', 'physique', 'body building', 'mr olympia', 'arnold classic'],
  },
  {
    value: 'crossfit',
    label: 'CrossFit',
    group: 'Fitness',
    aliases: ['wod', 'cross fit', 'crossfit games', 'amrap', 'emom', 'metcon', 'rx'],
  },
  {
    value: 'calisthenics',
    label: 'Calisthenics',
    group: 'Fitness',
    aliases: ['bodyweight training', 'bodyweight', 'street workout', 'muscle up', 'handstand', 'planche'],
  },
  { value: 'kettlebells', label: 'Kettlebells', group: 'Fitness', aliases: ['kettlebell', 'kb', 'girevoy', 'kettlebell sport'] },
  {
    value: 'strongman',
    label: 'Strongman',
    group: 'Fitness',
    aliases: ['atlas stones', 'log press', 'yoke', 'farmers walk', "world's strongest man", 'wsm'],
  },
  { value: 'yoga', label: 'Yoga', group: 'Wellness', aliases: ['vinyasa', 'hatha', 'yin yoga', 'asana'] },
  { value: 'mobility', label: 'Mobility', group: 'Wellness', aliases: ['stretching', 'range of motion', 'rom', 'foam rolling', 'prehab'] },

  // Fitness (endurance)
  { value: 'running', label: 'Running', group: 'Endurance', aliases: ['5k', '10k', 'half marathon', 'marathon', 'ultramarathon', 'ultra'] },
  { value: 'trail_running', label: 'Trail running', group: 'Endurance', aliases: ['trail run', 'trailrunner', 'trail running', 'utmb'] },
  { value: 'cycling', label: 'Cycling', group: 'Endurance', aliases: ['biking', 'bike ride', 'road cycling', 'mountain biking', 'mtb', 'peloton'] },
  { value: 'swimming', label: 'Swimming', group: 'Endurance', aliases: ['lap swim', 'open water', 'freestyle', 'butterfly'] },
  { value: 'triathlon', label: 'Triathlon', group: 'Endurance', aliases: ['ironman', '70.3', 'tri'] },
  { value: 'rowing', label: 'Rowing', group: 'Endurance', aliases: ['erg', 'concept2', 'rowing machine', 'c2'] },

  // Sports
  { value: 'basketball', label: 'Basketball', group: 'Sports', aliases: ['nba', 'wnba', 'hoops'] },
  { value: 'soccer', label: 'Soccer', group: 'Sports', aliases: ['fifa', 'mls', 'premier league', 'world cup', 'uefa'] },
  { value: 'baseball', label: 'Baseball', group: 'Sports', aliases: ['mlb', 'home run', 'pitching', 'batting'] },
  { value: 'football', label: 'Football', group: 'Sports', aliases: ['nfl', 'touchdown', 'quarterback', 'qb'] },
  { value: 'hockey', label: 'Hockey', group: 'Sports', aliases: ['nhl', 'ice hockey', 'stanley cup'] },
  { value: 'tennis', label: 'Tennis', group: 'Sports', aliases: ['atp', 'wta', 'grand slam', 'wimbledon', 'us open'] },
  { value: 'pickleball', label: 'Pickleball', group: 'Sports', aliases: ['pickle ball'] },
  { value: 'golf', label: 'Golf', group: 'Sports', aliases: ['pga', 'tee time', 'handicap'] },

  // Combat sports
  { value: 'martial_arts', label: 'Martial arts', group: 'Combat sports', aliases: ['martial arts', 'dojo', 'karate', 'taekwondo', 'kung fu', 'krav maga'] },
  { value: 'boxing', label: 'Boxing', group: 'Combat sports', aliases: ['sparring', 'heavyweight'] },
  { value: 'kickboxing', label: 'Kickboxing', group: 'Combat sports', aliases: ['kick boxing', 'k1', 'k 1', 'k-1'] },
  { value: 'muay_thai', label: 'Muay Thai', group: 'Combat sports', aliases: ['muaythai', 'thai boxing', 'clinch'] },
  { value: 'mma', label: 'MMA', group: 'Combat sports', aliases: ['mixed martial arts', 'ufc', 'octagon'] },
  { value: 'wrestling', label: 'Wrestling', group: 'Combat sports', aliases: ['takedown', 'pin', 'ncaa wrestling'] },
  { value: 'judo', label: 'Judo', group: 'Combat sports', aliases: ['ippon'] },
  {
    value: 'jiu_jitsu',
    label: 'Jiu-jitsu',
    group: 'Combat sports',
    aliases: ['jiu jitsu', 'jiujitsu', 'jiu-jitsu', 'bjj', 'brazilian jiu jitsu', 'nogi', 'no gi', 'guard', 'submission', 'ibjjf'],
  },

  // Outdoors
  { value: 'hiking', label: 'Hiking', group: 'Outdoors', aliases: ['day hike', 'trailhead', 'backcountry'] },
  { value: 'camping', label: 'Camping', group: 'Outdoors', aliases: ['tent', 'campfire', 'camp site'] },
  { value: 'backpacking', label: 'Backpacking', group: 'Outdoors', aliases: ['thru hike', 'through hike', 'appalachian trail', 'pacific crest trail', 'pct', 'at'] },
  { value: 'fishing', label: 'Fishing', group: 'Outdoors', aliases: ['angler', 'fly fishing', 'tackle'] },
  { value: 'hunting', label: 'Hunting', group: 'Outdoors', aliases: ['bowhunting', 'deer', 'elk', 'duck hunting'] },
  { value: 'climbing', label: 'Climbing', group: 'Outdoors', aliases: ['rock climbing'] },
  { value: 'skiing', label: 'Skiing', group: 'Outdoors', aliases: ['powder', 'apres'] },
  { value: 'snowboarding', label: 'Snowboarding', group: 'Outdoors', aliases: ['snowboard', 'halfpipe'] },
  { value: 'kayaking', label: 'Kayaking', group: 'Outdoors', aliases: ['kayak', 'whitewater'] },

  // Motors
  { value: 'motorcycles', label: 'Motorcycles', group: 'Motors', aliases: ['motorcycle', 'motorbike', 'harley', 'ducati', 'yamaha', 'honda'] },
  { value: 'cars', label: 'Cars', group: 'Motors', aliases: ['car', 'auto', 'tesla', 'mustang', 'bmw'] },
  { value: 'off_roading', label: 'Off-roading', group: 'Motors', aliases: ['4x4', '4wd', 'overlanding', 'overland', 'jeep'] },

  // Food & drink
  { value: 'cooking', label: 'Cooking', group: 'Food & drink', aliases: ['cook', 'recipes', 'recipe', 'meal prep', 'cookbook', 'air fryer', 'instant pot'] },
  { value: 'bbq', label: 'BBQ', group: 'Food & drink', aliases: ['barbecue', 'grilling', 'smoking', 'smoker', 'brisket', 'ribs', 'pulled pork', 'pitmaster', 'traeger'] },
  { value: 'coffee', label: 'Coffee', group: 'Food & drink', aliases: ['espresso', 'latte', 'cappuccino', 'pour over', 'aeropress', 'cold brew'] },
  { value: 'whiskey', label: 'Whiskey', group: 'Food & drink', aliases: ['bourbon', 'scotch', 'rye', 'single malt', 'whisky'] },
  { value: 'craft_beer', label: 'Craft beer', group: 'Food & drink', aliases: ['beer', 'ipa', 'stout', 'brewery', 'microbrew'] },
  { value: 'nutrition', label: 'Nutrition', group: 'Wellness', aliases: ['macros', 'protein', 'calories', 'cutting', 'bulking', 'diet', 'keto', 'carnivore', 'intermittent fasting'] },

  // Tech & games
  { value: 'tech', label: 'Tech', group: 'Tech & games', aliases: ['technology', 'software', 'hardware', 'gadgets', 'startup', 'saas'] },
  { value: 'programming', label: 'Programming', group: 'Tech & games', aliases: ['coding', 'developer', 'dev', 'software engineer', 'engineering', 'typescript', 'javascript', 'python', 'golang', 'java', 'rust', 'react', 'vue', 'nuxt', 'node', 'api', 'backend', 'frontend', 'open source', 'github'] },
  {
    value: 'ai',
    label: 'AI',
    group: 'Tech & games',
    aliases: [
      // Core terms
      'artificial intelligence',
      'machine learning',
      'deep learning',
      'ml',
      'llm',
      'llms',
      'large language model',
      'large language models',
      'generative ai',
      'gen ai',
      'chatbot',
      // Major vendors + products
      'openai',
      'chatgpt',
      'gpt',
      'gpt 4',
      'gpt 4o',
      'o1',
      'anthropic',
      'claude',
      'google ai',
      'gemini',
      'deepmind',
      'meta ai',
      'llama',
      'mistral',
      'cohere',
      'hugging face',
      // xAI / Grok
      'xai',
      'x ai',
      'x.ai',
      'grok',
      // Infra / concepts that are usually AI-specific
      'prompt',
      'prompting',
      'prompt engineering',
      'fine tuning',
      'finetuning',
      'rag',
      'retrieval augmented generation',
      'embeddings',
      'vector database',
      'vector db',
      'token',
      'tokens',
      'inference',
      // Common model repos/tools
      'stable diffusion',
      'midjourney',
      'dalle',
      'dall e',
      'whisper',
    ],
  },
  { value: 'cybersecurity', label: 'Cybersecurity', group: 'Tech & games', aliases: ['infosec', 'security', 'pentest', 'penetration testing', 'vulnerability', 'breach', 'malware', 'ransomware', 'phishing', 'zero day', 'cve', 'ctf'] },
  { value: 'gaming', label: 'Gaming', group: 'Tech & games', aliases: ['games', 'video games', 'pc gaming', 'steam', 'xbox', 'playstation', 'ps5', 'nintendo', 'switch'] },
  { value: 'board_games', label: 'Board games', group: 'Tech & games', aliases: ['tabletop games', 'tabletop', 'boardgame', 'dnd', 'd&d', 'dungeons and dragons', 'tabletop rpg'] },

  // Learning & culture
  { value: 'books', label: 'Books', group: 'Learning', aliases: ['reading', 'kindle', 'goodreads', 'audiobook', 'audiobooks'] },
  { value: 'podcasts', label: 'Podcasts', group: 'Learning', aliases: ['podcast'] },
  { value: 'history', label: 'History', group: 'Learning' },
  { value: 'philosophy', label: 'Philosophy', group: 'Learning', aliases: ['stoicism', 'stoic'] },
  { value: 'psychology', label: 'Psychology', group: 'Learning' },
  { value: 'language_learning', label: 'Language learning', group: 'Learning', aliases: ['learning languages', 'duolingo', 'anki', 'flashcards'] },

  // Business & money
  { value: 'entrepreneurship', label: 'Entrepreneurship', group: 'Business', aliases: ['business', 'startups', 'startup'] },
  { value: 'investing', label: 'Investing', group: 'Business', aliases: ['stocks', 'crypto', 'etf', 'index funds', '401k', 'roth', 'dividends'] },
  { value: 'real_estate', label: 'Real estate', group: 'Business', aliases: ['realestate', 'mortgage', 'rental property', 'airbnb'] },
  { value: 'career_growth', label: 'Career growth', group: 'Business', aliases: ['career', 'jobs', 'resume', 'interview', 'promotion'] },

  // Arts & entertainment
  { value: 'music', label: 'Music', group: 'Arts', aliases: ['spotify', 'band', 'songwriting'] },
  { value: 'guitar', label: 'Guitar', group: 'Arts', aliases: ['electric guitar', 'acoustic guitar', 'chords', 'tabs', 'riff'] },
  { value: 'photography', label: 'Photography', group: 'Arts', aliases: ['dslr', 'mirrorless', 'lens', 'aperture', 'iso'] },
  { value: 'movies', label: 'Movies', group: 'Arts', aliases: ['film'] },

  // Life
  { value: 'travel', label: 'Travel', group: 'Life', aliases: ['traveling', 'vacation', 'flight', 'hotel', 'passport'] },
  { value: 'road_trips', label: 'Road trips', group: 'Life', aliases: ['roadtrip', 'road trip', 'vanlife', 'van life'] },
  // Religion / faith
  { value: 'faith', label: 'Faith', group: 'Religion', aliases: ['church', 'spirituality', 'spiritual', 'prayer', 'pray', 'god'] },
  { value: 'christianity', label: 'Christianity', group: 'Religion', aliases: ['christian', 'jesus', 'christ'] },
  { value: 'catholicism', label: 'Catholicism', group: 'Religion', aliases: ['catholic', 'mass', 'rosary', 'pope'] },
  { value: 'protestantism', label: 'Protestantism', group: 'Religion', aliases: ['protestant', 'baptist', 'methodist', 'lutheran'] },
  { value: 'orthodox_christianity', label: 'Orthodox Christianity', group: 'Religion', aliases: ['orthodox', 'eastern orthodox', 'orthodoxy'] },
  { value: 'bible_study', label: 'Bible study', group: 'Religion', aliases: ['bible', 'scripture'] },
  // Politics / civics
  { value: 'politics', label: 'Politics', group: 'Politics', aliases: ['political', 'congress', 'senate'] },
  { value: 'current_events', label: 'Current events', group: 'Politics', aliases: ['news', 'breaking news'] },
  { value: 'civics', label: 'Civics', group: 'Politics', aliases: ['government', 'constitution'] },
  { value: 'policy', label: 'Policy', group: 'Politics', aliases: ['public policy'] },
  { value: 'elections', label: 'Elections', group: 'Politics', aliases: ['voting', 'ballot', 'primary'] },
  { value: 'law', label: 'Law', group: 'Politics', aliases: ['legal', 'court', 'supreme court'] },
  { value: 'economics', label: 'Economics', group: 'Politics', aliases: ['economy', 'inflation', 'gdp', 'recession'] },
  { value: 'geopolitics', label: 'Geopolitics', group: 'Politics', aliases: ['international relations', 'foreign policy', 'war'] },
  { value: 'volunteering', label: 'Volunteering', group: 'Community', aliases: ['service', 'volunteer', 'charity', 'nonprofit'] },
  { value: 'fatherhood', label: 'Fatherhood', group: 'Family', aliases: ['dad', 'dads', 'parenting'] },
  { value: 'mens_groups', label: "Men's groups", group: 'Community', aliases: ['mens group', "men's group"] },
  { value: 'mentorship', label: 'Mentorship', group: 'Community', aliases: ['mentoring', 'mentor', 'coaching'] },
  { value: 'mental_health', label: 'Mental health', group: 'Wellness', aliases: ['therapy', 'anxiety', 'depression', 'counseling'] },
  { value: 'meditation', label: 'Meditation', group: 'Wellness', aliases: ['mindfulness', 'breathwork', 'breathing'] },
];

