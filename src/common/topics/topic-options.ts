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
  { value: 'weightlifting', label: 'Weightlifting', group: 'Fitness', aliases: ['oly', 'olympic lifting'] },
  { value: 'powerlifting', label: 'Powerlifting', group: 'Fitness', aliases: ['squat', 'bench', 'deadlift'] },
  { value: 'bodybuilding', label: 'Bodybuilding', group: 'Fitness', aliases: ['hypertrophy'] },
  { value: 'crossfit', label: 'CrossFit', group: 'Fitness', aliases: ['wod'] },
  { value: 'calisthenics', label: 'Calisthenics', group: 'Fitness', aliases: ['bodyweight training', 'bodyweight'] },
  { value: 'kettlebells', label: 'Kettlebells', group: 'Fitness', aliases: ['kettlebell'] },
  { value: 'strongman', label: 'Strongman', group: 'Fitness', aliases: ['atlas stones'] },
  { value: 'yoga', label: 'Yoga', group: 'Wellness' },
  { value: 'mobility', label: 'Mobility', group: 'Wellness', aliases: ['stretching'] },

  // Fitness (endurance)
  { value: 'running', label: 'Running', group: 'Endurance' },
  { value: 'trail_running', label: 'Trail running', group: 'Endurance', aliases: ['trail run', 'trailrunner'] },
  { value: 'cycling', label: 'Cycling', group: 'Endurance' },
  { value: 'swimming', label: 'Swimming', group: 'Endurance' },
  { value: 'triathlon', label: 'Triathlon', group: 'Endurance' },
  { value: 'rowing', label: 'Rowing', group: 'Endurance' },

  // Sports
  { value: 'basketball', label: 'Basketball', group: 'Sports' },
  { value: 'soccer', label: 'Soccer', group: 'Sports' },
  { value: 'baseball', label: 'Baseball', group: 'Sports' },
  { value: 'football', label: 'Football', group: 'Sports' },
  { value: 'hockey', label: 'Hockey', group: 'Sports' },
  { value: 'tennis', label: 'Tennis', group: 'Sports' },
  { value: 'pickleball', label: 'Pickleball', group: 'Sports' },
  { value: 'golf', label: 'Golf', group: 'Sports' },

  // Combat sports
  { value: 'martial_arts', label: 'Martial arts', group: 'Combat sports', aliases: ['martial arts'] },
  { value: 'boxing', label: 'Boxing', group: 'Combat sports' },
  { value: 'kickboxing', label: 'Kickboxing', group: 'Combat sports' },
  { value: 'muay_thai', label: 'Muay Thai', group: 'Combat sports', aliases: ['muaythai'] },
  { value: 'mma', label: 'MMA', group: 'Combat sports', aliases: ['mixed martial arts'] },
  { value: 'wrestling', label: 'Wrestling', group: 'Combat sports' },
  { value: 'judo', label: 'Judo', group: 'Combat sports' },
  { value: 'jiu_jitsu', label: 'Jiu-jitsu', group: 'Combat sports', aliases: ['jiu jitsu', 'bjj', 'brazilian jiu jitsu'] },

  // Outdoors
  { value: 'hiking', label: 'Hiking', group: 'Outdoors' },
  { value: 'camping', label: 'Camping', group: 'Outdoors' },
  { value: 'backpacking', label: 'Backpacking', group: 'Outdoors' },
  { value: 'fishing', label: 'Fishing', group: 'Outdoors' },
  { value: 'hunting', label: 'Hunting', group: 'Outdoors' },
  { value: 'climbing', label: 'Climbing', group: 'Outdoors', aliases: ['rock climbing'] },
  { value: 'skiing', label: 'Skiing', group: 'Outdoors' },
  { value: 'snowboarding', label: 'Snowboarding', group: 'Outdoors' },
  { value: 'kayaking', label: 'Kayaking', group: 'Outdoors' },

  // Motors
  { value: 'motorcycles', label: 'Motorcycles', group: 'Motors', aliases: ['motorcycle'] },
  { value: 'cars', label: 'Cars', group: 'Motors', aliases: ['car'] },
  { value: 'off_roading', label: 'Off-roading', group: 'Motors', aliases: ['4x4', 'overlanding'] },

  // Food & drink
  { value: 'cooking', label: 'Cooking', group: 'Food & drink', aliases: ['cook', 'recipes', 'meal prep'] },
  { value: 'bbq', label: 'BBQ', group: 'Food & drink', aliases: ['barbecue', 'grilling', 'smoking'] },
  { value: 'coffee', label: 'Coffee', group: 'Food & drink' },
  { value: 'whiskey', label: 'Whiskey', group: 'Food & drink', aliases: ['bourbon', 'scotch'] },
  { value: 'craft_beer', label: 'Craft beer', group: 'Food & drink', aliases: ['beer'] },
  { value: 'nutrition', label: 'Nutrition', group: 'Wellness' },

  // Tech & games
  { value: 'tech', label: 'Tech', group: 'Tech & games', aliases: ['technology', 'software', 'programming'] },
  { value: 'programming', label: 'Programming', group: 'Tech & games', aliases: ['coding', 'developer', 'dev'] },
  { value: 'ai', label: 'AI', group: 'Tech & games', aliases: ['artificial intelligence', 'machine learning', 'ml'] },
  { value: 'cybersecurity', label: 'Cybersecurity', group: 'Tech & games', aliases: ['infosec', 'security'] },
  { value: 'gaming', label: 'Gaming', group: 'Tech & games', aliases: ['games', 'video games'] },
  { value: 'board_games', label: 'Board games', group: 'Tech & games', aliases: ['tabletop games', 'tabletop'] },

  // Learning & culture
  { value: 'books', label: 'Books', group: 'Learning', aliases: ['reading'] },
  { value: 'podcasts', label: 'Podcasts', group: 'Learning' },
  { value: 'history', label: 'History', group: 'Learning' },
  { value: 'philosophy', label: 'Philosophy', group: 'Learning' },
  { value: 'psychology', label: 'Psychology', group: 'Learning' },
  { value: 'language_learning', label: 'Language learning', group: 'Learning', aliases: ['learning languages'] },

  // Business & money
  { value: 'entrepreneurship', label: 'Entrepreneurship', group: 'Business', aliases: ['business', 'startups', 'startup'] },
  { value: 'investing', label: 'Investing', group: 'Business', aliases: ['stocks', 'crypto'] },
  { value: 'real_estate', label: 'Real estate', group: 'Business', aliases: ['realestate'] },
  { value: 'career_growth', label: 'Career growth', group: 'Business', aliases: ['career', 'jobs'] },

  // Arts & entertainment
  { value: 'music', label: 'Music', group: 'Arts' },
  { value: 'guitar', label: 'Guitar', group: 'Arts' },
  { value: 'photography', label: 'Photography', group: 'Arts' },
  { value: 'movies', label: 'Movies', group: 'Arts', aliases: ['film'] },

  // Life
  { value: 'travel', label: 'Travel', group: 'Life', aliases: ['traveling'] },
  { value: 'road_trips', label: 'Road trips', group: 'Life', aliases: ['roadtrip'] },
  // Religion / faith
  { value: 'faith', label: 'Faith', group: 'Religion', aliases: ['church', 'spirituality', 'spiritual'] },
  { value: 'christianity', label: 'Christianity', group: 'Religion', aliases: ['christian'] },
  { value: 'catholicism', label: 'Catholicism', group: 'Religion', aliases: ['catholic'] },
  { value: 'protestantism', label: 'Protestantism', group: 'Religion', aliases: ['protestant'] },
  { value: 'orthodox_christianity', label: 'Orthodox Christianity', group: 'Religion', aliases: ['orthodox'] },
  { value: 'bible_study', label: 'Bible study', group: 'Religion', aliases: ['bible'] },
  // Politics / civics
  { value: 'politics', label: 'Politics', group: 'Politics', aliases: ['political'] },
  { value: 'current_events', label: 'Current events', group: 'Politics', aliases: ['news'] },
  { value: 'civics', label: 'Civics', group: 'Politics', aliases: ['government'] },
  { value: 'policy', label: 'Policy', group: 'Politics', aliases: ['public policy'] },
  { value: 'elections', label: 'Elections', group: 'Politics', aliases: ['voting'] },
  { value: 'law', label: 'Law', group: 'Politics', aliases: ['legal'] },
  { value: 'economics', label: 'Economics', group: 'Politics', aliases: ['economy'] },
  { value: 'geopolitics', label: 'Geopolitics', group: 'Politics', aliases: ['international relations'] },
  { value: 'volunteering', label: 'Volunteering', group: 'Community', aliases: ['service'] },
  { value: 'fatherhood', label: 'Fatherhood', group: 'Family', aliases: ['dad', 'dads', 'parenting'] },
  { value: 'mens_groups', label: "Men's groups", group: 'Community', aliases: ['mens group', "men's group"] },
  { value: 'mentorship', label: 'Mentorship', group: 'Community', aliases: ['mentoring'] },
  { value: 'mental_health', label: 'Mental health', group: 'Wellness', aliases: ['therapy'] },
  { value: 'meditation', label: 'Meditation', group: 'Wellness', aliases: ['mindfulness'] },
];

