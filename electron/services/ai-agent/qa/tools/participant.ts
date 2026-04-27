/**
 * 参与者解析工具。
 */
import { agentDataRepository } from '../data/repository'
import type { ContextWindow, KnownSearchHit, ParticipantResolution, ToolLoopAction } from '../types'
import { compactText } from '../utils/text'
import { dedupeMessagesByCursor, describeSender, participantMatches } from '../utils/message'

export async function resolveParticipantName(input: {
  sessionId: string
  name?: string
  contextWindows: ContextWindow[]
  knownHits: KnownSearchHit[]
}): Promise<ParticipantResolution> {
  const query = compactText(input.name || '', 48)
  const observedMessages = dedupeMessagesByCursor([
    ...input.contextWindows.flatMap((w) => w.messages),
    ...input.knownHits.map((h) => h.message)
  ])

  if (query) {
    const observed = observedMessages.find((m) => participantMatches(query, m))
    if (observed?.sender.username || observed?.sender.displayName) {
      return {
        query,
        senderUsername: observed.sender.username || undefined,
        displayName: describeSender(observed),
        confidence: observed.sender.username ? 'high' : 'medium',
        source: 'observed'
      }
    }
  }

  if (query) {
    const normalized = query.toLowerCase()
    const candidates = [
      ...agentDataRepository.listContacts(),
      ...agentDataRepository.loadGroupMembers(input.sessionId)
    ]
    const exact = candidates.find((contact) => {
      const names = [contact.displayName, contact.remark || '', contact.nickname || '', contact.contactId]
      return names.some((name) => name && (name === query || name.toLowerCase() === normalized))
    })
    const partial = exact || candidates.find((contact) => {
      const names = [contact.displayName, contact.remark || '', contact.nickname || '', contact.contactId]
      return names.some((name) => {
        const candidate = name.toLowerCase()
        return Boolean(candidate) && (candidate.includes(normalized) || normalized.includes(candidate))
      })
    })

    if (partial) {
      return {
        query,
        senderUsername: partial.contactId,
        displayName: partial.displayName || partial.remark || partial.nickname || partial.contactId,
        confidence: exact ? 'high' : 'medium',
        source: 'contacts'
      }
    }
  }

  return { query: query || '未指定参与者', confidence: 'low', source: 'fallback' }
}

export function findResolvedSenderUsername(action: Extract<ToolLoopAction, { action: 'read_by_time_range' }>, resolvedParticipants: ParticipantResolution[]): string | undefined {
  if (action.senderUsername) return action.senderUsername
  if (!action.participantName) return resolvedParticipants.find((i) => i.senderUsername)?.senderUsername
  const normalized = action.participantName.toLowerCase()
  return resolvedParticipants.find((i) => {
    const displayName = (i.displayName || '').toLowerCase()
    return i.query.toLowerCase() === normalized || (Boolean(displayName) && (displayName.includes(normalized) || normalized.includes(displayName)))
  })?.senderUsername
}
