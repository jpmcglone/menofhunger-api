const CORE_CHECKIN_PROMPTS: string[] = [
  "What’s one win you had today?",
  "What’s one thing you’re grateful for today?",
  "What’s one hard thing you did today anyway?",
  "What’s one thing you need support with right now?",
  "What’s one habit you’re trying to build this week?",
  "What’s one thing you’re avoiding — and why?",
  "What’s one thing you want to do tomorrow that would make you proud?",
  "What’s one thing you learned today?",
  "What’s one thing you can do for your health today?",
  "What’s one thing you’re committed to finishing this week?",
  "What’s one thing you wish you could tell your past self?",
  "What’s one thing you want accountability on?",
  "What’s one thing you did today that aligns with your values?",
  "What’s one thing you can simplify right now?",
  "What’s one relationship you want to strengthen this week?",
  "What’s one thought you need to let go of today?",
  "What’s one thing you’re excited about?",
  "What’s one thing you can do today to make tomorrow easier?",

  "What did you do today that you didn’t feel like doing?",
  "What’s one decision you made today that you’re glad you made?",
  "What’s one decision you need to make soon?",
  "What’s one thing you said “no” to today?",
  "What’s one thing you said “yes” to today?",
  "What’s one distraction you can cut this week?",
  "What’s one boundary you need to set or reinforce?",
  "What’s one promise you kept today (to yourself or someone else)?",
  "What’s one promise you want to keep tomorrow?",

  "What’s one fear you faced today?",
  "What’s one thing you handled better than you would have last year?",
  "What’s one uncomfortable conversation you need to have?",
  "What’s one thing you’re procrastinating — what’s the first tiny step?",
  "What’s one belief that’s holding you back right now?",
  "What’s one story you can stop telling yourself?",
  "What’s one thing you’re overthinking?",
  "What would “good enough” look like for you today?",

  "What’s one thing you did today that required discipline?",
  "What’s one hard thing you’re going to do tomorrow?",
  "What’s one thing you can do in the next 10 minutes that moves you forward?",
  "What’s one habit that’s helping you right now?",
  "What’s one habit that’s hurting you right now?",
  "What’s one temptation you resisted today?",

  "What’s one thing you can do today to improve your sleep tonight?",
  "What’s one health choice you want to make tomorrow?",
  "What’s one physical win you had today (movement, training, recovery)?",

  "What’s one task you completed today that you’ve been putting off?",
  "What’s the single most important task for tomorrow?",
  "What’s one thing you can delegate, delay, or delete?",
  "What’s one “two-minute task” you can knock out right now?",
  "What’s one system you can build so you don’t rely on motivation?",

  "What’s one way you served someone today?",
  "Who’s one person you should reach out to this week?",
  "What’s one relationship you neglected lately — what’s one step to repair it?",
  "What’s one thing you appreciate about someone in your life?",
  "What’s one apology you owe (or might owe)?",

  "What’s one thing you’re proud of — even if it’s small?",
  "What’s one thing you’re thankful you *didn’t* do today?",
  "What’s one moment you want to remember from today?",
  "What’s one thing you want to stop doing starting tomorrow?",
  "What’s one thing you want to start doing starting tomorrow?",

  "What’s one lesson today taught you the hard way?",
  "What’s one mistake you made today — what will you do differently next time?",
  "What’s one thing you learned about yourself recently?",

  "What’s one thing you can do to reduce stress this week?",
  "What’s one thing you’re carrying that you can put down?",
  "What’s one worry you can turn into a plan?",
  "What’s one thing you can control right now?",
  "What’s one thing you can’t control — and can release?",

  "What’s one skill you want to improve this month?",
  "What’s one book, idea, or quote that’s been helping you lately?",
  "What’s one input you need less of (news, social, sugar, etc.)?",
  "What’s one input you need more of (sleep, prayer/quiet, sunlight, etc.)?",

  "What’s one thing you did today that your future self will thank you for?",
  "If tomorrow goes great, what will you have done tonight to set it up?",
  "What’s one thing you can do tonight to close the day well?",
  "What’s one thing you can do tomorrow morning to win the day early?",

  "What’s one thing you’re building — and what did you do today to build it?",
  "What’s one thing you’re learning — and what did you practice today?",
  "What’s one way you showed courage today?",

  "What’s one thing you can do today that’s aligned with who you want to become?",
  "What’s one area of your life that needs more honesty right now?",
  "What’s one area of your life that needs more consistency right now?",

  // Man-building / character / responsibility
  "Where did you lead well today — and where did you avoid leading?",
  "What responsibility are you tempted to dodge right now?",
  "What did you do today that a boy would avoid but a man does anyway?",
  "What’s one hard truth you need to face (and what will you do about it)?",
  "Where did you choose comfort over character today?",
  "What did you practice today: courage or convenience?",
  "What’s one small act of integrity you can do before bed?",
  "What’s one area where you need to stop making excuses?",
  "What’s one thing you need to do even if nobody notices?",

  // Discipline / habits / mastery
  "What did you do today that you’ll be grateful you did a year from now?",
  "What’s the smallest daily standard that would change your life if you kept it for 90 days?",
  "What’s one habit you need to rebuild from the ground up?",
  "What’s one thing you can do daily that makes you harder to break?",
  "What’s one thing you’ll stop negotiating with yourself about?",
  "What’s one area where you need reps, not inspiration?",

  // Faith / conscience / inner life (light-touch, optional)
  "What’s one thing you need to confess to God (or at least admit to yourself)?",
  "What’s one thing you’re praying for — and what’s one step you can take while you pray?",
  "What did you feed your mind today — and did it make you better or weaker?",
  "Where did you ignore your conscience today?",
  "What’s one thing you can do tonight to put your soul in order?",

  // Family / marriage / fatherhood / relationships
  "How did you love your people well today (in action, not intention)?",
  "What’s one way you can serve your wife/family this week (specific, measurable)?",
  "What’s one moment today you could have been more patient at home?",
  "What’s one thing you need to say to your wife/kids/family that you’ve been holding back?",
  "What kind of man do your closest people experience you as right now?",
  "Where do you need to show up consistently instead of occasionally?",

  // Work / craft / purpose
  "What’s the highest-leverage thing you did today?",
  "What’s one thing you did today that moved the needle (not just kept you busy)?",
  "What’s one task you can do tomorrow that would make the rest of your week easier?",
  "What’s one skill at work you need to sharpen — and what’s your next rep?",

  // Money / stewardship
  "What’s one money decision you made today — did it align with your values?",
  "What’s one expense you can cut without losing anything important?",
  "What’s one financial habit you need to build this month?",
  "What’s one way you can be a better steward of what you have?",

  // Fitness / strength / self-control
  "Did you train today? If not, why not — and what’s the plan?",
  "What’s one choice you made today that strengthened self-control?",
  "What’s one recovery habit you’ll take seriously this week (sleep, steps, food, stretching)?",
  "What’s one physical standard you want to hold the line on?",

  // Brotherhood / service / leadership
  "Who did you encourage today — specifically?",
  "Who can you help this week without getting anything back?",
  "What’s one relationship you need to invest in (mentorship, friendship, brotherhood)?",
  "Where do you need to be more direct instead of passive?",
];

const CONVERSATION_STARTER_PROMPTS: string[] = [
  // Life stories / lessons
  "What's a lesson you learned the hard way that younger men should hear sooner?",
  "What's a mistake that made you better after it humbled you?",
  "What's something your father, coach, or mentor said that stuck with you?",
  "What's one decision that quietly changed the direction of your life?",
  "What's one belief you changed your mind about as you got older?",
  "What's a moment when you realized you needed to grow up?",

  // Brotherhood / honest conversation
  "What's something men talk about too little?",
  "What's one thing a good friend has challenged you on lately?",
  "What's the difference between encouragement and flattery?",
  "What's one sign a man is trustworthy?",
  "What's one quality you respect immediately in another man?",
  "What's one conversation you've been putting off with a brother?",

  // Convictions / opinions worth discussing
  "What's one unpopular opinion you hold about discipline?",
  "What's one modern convenience that has made men softer?",
  "What's one old-school virtue worth bringing back?",
  "What's one thing people call strength that is really insecurity?",
  "What's one thing people call weakness that might actually be wisdom?",
  "What's one lie about manhood you had to unlearn?",
  "What's one area where culture rewards the wrong thing?",
  "What's one thing you think men overcomplicate?",
  "What's one thing worth being stubborn about?",

  // Work / purpose / ambition
  "What's work teaching you about your character right now?",
  "What's one thing that separates busy men from useful men?",
  "What's one thing you're trying to become excellent at?",
  "What's one project that would make you proud if you finished it?",
  "What's one tradeoff ambition has forced you to face?",
  "What's one sign you're doing meaningful work and not just staying busy?",

  // Family / home / relationships
  "What's one thing a strong home needs that money can't buy?",
  "What's one way a man earns trust at home?",
  "What's one thing marriage or family has taught you about yourself?",
  "What's one thing your family needs from you when you're tired?",
  "What's one thing you learned from watching a good husband or father?",
  "What's one relationship lesson you had to learn the hard way?",
  "What's one way love becomes visible in ordinary life?",

  // Faith / conscience / meaning
  "What's one practice that helps you hear your conscience more clearly?",
  "What's one verse, prayer, quote, or idea that's been working on you lately?",
  "What's one thing that helps you get quiet enough to be honest?",
  "What's one place where you need more trust and less control?",
  "What's one thing suffering has taught you about what matters?",
  "What's one sign you're spiritually drifting?",
  "What's one thing you believe is worth sacrificing for?",

  // Health / training / body
  "What's one thing training has taught you outside the gym?",
  "What's one health habit that changed your mood more than you expected?",
  "What's one thing men misunderstand about rest?",
  "What's one physical challenge you want to be ready for?",
  "What's one reason fitness matters beyond appearance?",
  "What's one thing your body has been trying to tell you lately?",
  "What's one recovery habit you used to dismiss but now respect?",
  "What's one way stress shows up in your body?",
  "What's one way a man can build toughness without being reckless?",

  // Money / stewardship / simplicity
  "What's one money lesson you had to learn by paying for it?",
  "What's one purchase you made that was actually worth it?",
  "What's one purchase you regret because it promised too much?",
  "What's one way money reveals what a man values?",
  "What's one way generosity has changed you?",
  "What's one area where simple living would make you freer?",

  // Failure / resilience / risk
  "What's one failure that taught you more than winning did?",
  "What's one risk you took that was worth it?",
  "What's one risk you avoided that you now wish you had taken?",
  "What's one sign a man is avoiding discomfort instead of using wisdom?",
  "What's one pressure that revealed what you were made of?",
  "What's one fear that got smaller once you faced it?",
  "What's one thing courage has cost you?",
  "What's one thing resilience looks like on an ordinary Tuesday?",
  "What's one hard thing you would tell another man is worth enduring?",

  // Character / identity / self-knowledge
  "What's one strength you have to be careful not to misuse?",
  "What's one weakness you're finally willing to name plainly?",
  "What's one criticism that helped you once you stopped resisting it?",
  "What's one pattern you notice in yourself under pressure?",
  "What's one thing that brings out your best self?",
  "What's one thing that brings out your worst self?",
  "What's one way pride disguises itself in your life?",
  "What's one way humility has helped you make a better decision?",
  "What's one sign you're becoming more secure?",
  "What's one part of your past you're learning to own without being ruled by it?",
  "What's one value you want people to feel when they're around you?",

  // Practical wisdom / daily living
  "What's one rule of thumb that rarely fails you?",
  "What's one decision you can make once so you don't remake it every day?",
  "What's one tool, system, or habit that saves you from yourself?",
  "What's one thing you removed from your life that gave you more peace?",
  "What's one boundary that made your life better?",
  "What's one way to make the right thing easier and the wrong thing harder?",

  // Light but meaningful
  "What's one book, movie, sermon, or conversation you still think about?",
  "What's one meal that feels like home to you?",
  "What's one song, quote, or line that can still fire you up?",
  "What's one adventure you'd like to take with good men around you?",
  "What's one thing you enjoy that other people might not expect?",
  "What's one memory that still makes you laugh?",
  "What's one thing you want to be known for by the people closest to you?",

  // Table-talk / deeper discussion
  "What’s one thing you respect more now than you did ten years ago?",
  "What’s one thing you respect less now than you used to?",
  "What’s one lesson you learned from watching another man fail well?",
  "What’s one trait you hope younger men copy from you?",
  "What’s one trait you hope they do not copy from you?",
  "What’s one thing you can disagree about without losing respect for someone?",
  "What’s one topic you wish men could discuss with more honesty and less ego?",
  "What’s one assumption people often make about you that is wrong?",
  "What’s one part of your story you rarely explain but wish people understood?",
  "What’s one thing you’re learning from someone older than you?",
  "What’s one tradition from your family you want to change?",
  "What’s one moment when someone’s loyalty meant a lot to you?",
  "What’s one time someone told you the truth and you needed it?",
  "What’s one time you stayed silent when you should have spoken up?",
  "What’s one time speaking up cost you something but was still right?",
  "What’s one thing you think makes a man easier to trust over time?",
  "What’s one thing that makes a man harder to trust, even if he means well?",
  "What’s one difference between confidence and arrogance that you’ve noticed?",
  "What’s one difference between patience and avoidance?",
  "What’s one thing a man should be able to laugh at about himself?",
  "What’s one way you’ve learned to take yourself less seriously?",
  "What’s one way you’ve learned to take your responsibilities more seriously?",
  "What’s one problem in your community you wish good men would help solve?",
  "What’s one way technology helps you, and one way it weakens you?",
  "What’s one thing you do better when your phone is out of reach?",
  "What’s one thing solitude has taught you?",
  "What’s one thing community has taught you?",
  "What’s one kind of accountability that actually helps you change?",
  "What’s one kind of accountability that feels fake or performative?",
  "What’s one time a small act of service meant more than a grand gesture?",
  "What’s one way you want to be remembered by the men who know you best?",
  "What’s one skill your grandfather’s generation had that we should recover?",
  "What’s one personal rule you live by that other men might find useful?",
  "What’s one standard you picked up from another man and kept?",
  "What’s one question a friend could ask you today that would help you get unstuck?",
  "What’s one conversation you would like to see happen more often in this community?",
];

function interleavePrompts(primary: string[], secondary: string[]): string[] {
  const prompts: string[] = [];
  const max = Math.max(primary.length, secondary.length);

  for (let i = 0; i < max; i += 1) {
    if (primary[i]) prompts.push(primary[i]);
    if (secondary[i]) prompts.push(secondary[i]);
  }

  return prompts;
}

export const CHECKIN_PROMPTS: string[] = interleavePrompts(CORE_CHECKIN_PROMPTS, CONVERSATION_STARTER_PROMPTS);

