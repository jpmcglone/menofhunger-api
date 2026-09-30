/** Shared feature artwork exported from Figma page 26. Keep the API/web catalogs in sync. */
export type FeaturePage = {
  title: string
  description: string
  image: string
  routes: string[]
}

export const featurePages: FeaturePage[] = [
  { title: "Boards", description: "Discussion, questions, and ideas from the community.",
    image: "/images/features/boards-v1.png", routes: ["b"] },
  { title: "Articles", description: "Essays, perspectives, and stories from Men of Hunger.",
    image: "/images/features/articles-v1.png", routes: ["a", "articles"] },
  { title: "Fitness", description: "Training, activity, and progress—one day at a time.",
    image: "/images/features/fitness-v1.png", routes: ["fitness"] },
  { title: "Groups", description: "Smaller circles. Shared interests. Real connection.",
    image: "/images/features/groups-v1.png", routes: ["groups", "g"] },
  { title: "Spaces", description: "Live conversations with the men in your community.",
    image: "/images/features/spaces-v1.png", routes: ["spaces", "s", "radio"] },
  { title: "Daily", description: "A daily word and a quote to think about.",
    image: "/images/features/daily-v1.png", routes: ["daily"] },
  { title: "Check-ins", description: "Build consistency with your daily check-in.",
    image: "/images/features/check-ins-v1.png", routes: ["check-ins"] },
  { title: "Explore", description: "Discover people, posts, and conversations.",
    image: "/images/features/explore-v1.png", routes: ["explore"] },
  { title: "Crew", description: "Keep your people close on Men of Hunger.",
    image: "/images/features/crew-v1.png", routes: ["crew", "c"] },
  { title: 'Member map', description: 'See where the men of our community live.',
    image: '/og/map.png', routes: ['map', 'state'] },
]

/** Only route/public filter information belongs here: never private page content. */
export function featurePageForPath(path: string): FeaturePage | null {
  let url: URL
  try { url = new URL(path, 'https://menofhunger.com') } catch { return null }
  const parts = url.pathname.split('/').filter(Boolean)
  const first = parts[0] ?? ''
  const feature = featurePages.find((item) => item.routes.includes(first))
  if (!feature) return null
  const result = { ...feature }
  const second = parts[1]
  if (first === 'b') {
    const tag = url.searchParams.get('tag')?.trim().slice(0, 60)
    if (second === 'new') result.title = 'Start a discussion'
    else if (second) result.title = parts[2] === 'c' ? 'Board comment' : 'Board discussion'
    else if (tag) result.title = `${tag} · Boards`
  } else if ((first === 'a' || first === 'articles') && second) {
    result.title = second === 'new' ? 'Write an article' : second === 'edit' ? 'Edit article' : 'Article'
  } else if (first === 'fitness' && second === 'activities') {
    result.title = 'Fitness activity'
  } else if (first === 'daily' && second) {
    result.title = second === 'quote' ? 'Quote of the day' : second === 'word' ? 'Word of the day' : feature.title
  } else if (first === 'map' || first === 'state') {
    const state = (first === 'state' ? second : url.searchParams.get('state'))?.toUpperCase()
    if (state && /^[A-Z]{2}$/.test(state)) {
      result.title = `${state} · Member map`
      result.image = `/og/map.png?state=${state}`
    }
  } else if ((first === 'spaces' && second) || first === 's') {
    result.title = 'Space'
  } else if (first === 'g') {
    result.title = 'Group'
  }
  return result
}
