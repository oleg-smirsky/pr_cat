import { findUserById, findUserByEmail, createUser, updateUser } from "@/lib/repositories"

interface SessionUser {
  id: string
  name?: string | null
  email?: string | null
  image?: string | null
}

/**
 * Ensures a user exists in the database, creating or updating as needed
 * This handles the user initialization logic that was previously in the dashboard
 */
export async function ensureUserExists(sessionUser: SessionUser): Promise<void> {
  try {
    // Try to find user by ID first
    let dbUser = await findUserById(sessionUser.id)

    if (!dbUser) {
      // If not found by ID and we have an email, try email fallback
      if (sessionUser.email) {
        const userByEmail = await findUserByEmail(sessionUser.email)

        if (userByEmail) {
          await updateUser(userByEmail.id, {
            name: sessionUser.name ?? null,
            image: sessionUser.image ?? null,
          })
          return
        }
      }

      // No user exists - create new one (email may be null for private GitHub accounts)
      await createUser({
        id: sessionUser.id,
        name: sessionUser.name ?? null,
        email: sessionUser.email ?? null,
        image: sessionUser.image ?? null,
      })
    } else {
      // User exists - update their info in case it changed
      await updateUser(dbUser.id, {
        name: sessionUser.name ?? null,
        email: sessionUser.email ?? null,
        image: sessionUser.image ?? null,
      })
    }
  } catch (error) {
    console.error('Failed to ensure user exists:', error)
    throw new Error('User initialization failed')
  }
} 