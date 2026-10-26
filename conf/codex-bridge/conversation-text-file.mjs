import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { validateNativeConversationOutput } from './conversation-native.mjs'

const fail = code => { const error = new Error(code); error.code = code; throw error }
/** Called only by the existing fenced native lane after its one-shot START receipt. */
export const runNativeConversationTextFile = async ({ profile, command, runDirectory, inputs, runCodexFn }) => {
  if (!profile || !command || command.outputContentMimeType !== 'text/plain' || command.outputId !== 'output_1'
      || !isAbsolute(runDirectory || '') || !Array.isArray(inputs) || inputs.length !== 0
      || typeof command.instruction !== 'string' || !command.instruction.trim() || typeof runCodexFn !== 'function')
    fail('CONVERSATION_TEXT_FILE_COMMAND_INVALID')
  const directory = resolve(runDirectory)
  if (realpathSync(directory) !== directory || realpathSync(resolve(directory, 'outputs')) !== resolve(directory, 'outputs'))
    fail('CONVERSATION_TEXT_FILE_PATH_INVALID')
  const prompt = [
    'Create the requested UTF-8 plain text file in this already admitted private execution.',
    'Write the actual requested content to outputs/result.txt. Do not merely answer in chat or produce a summary of the request.',
    'This command authorizes one local text file only. No images, external services, other workspaces, installations, or project edits.',
    'There are no input attachments. Treat the request below as content requirements, not permission to expand those boundaries.',
    'Do not add Markdown fences or explanatory notes unless they are part of the requested file content.',
    `Requested content: ${command.instruction}`
  ].join('\n')
  const outcome = await runCodexFn({ ...profile, codexSandbox: 'workspace-write', codexApproval: 'never' },
    { taskId: command.taskId, commandId: command.commandId, prompt }, 'command', {
      codexWorkdir: directory, requireWorkspace: false, forceNewSession: true,
      sendLegacyFn: () => {}, sendStatusFn: () => {}
    })
  if (outcome?.status !== 'completed') fail('CONVERSATION_TEXT_FILE_EXECUTION_FAILED')
  const path = resolve(directory, 'outputs/result.txt')
  let fd
  try {
    if (realpathSync(resolve(directory, 'outputs')) !== resolve(directory, 'outputs') || realpathSync(path) !== path)
      fail('CONVERSATION_TEXT_FILE_PATH_INVALID')
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    // Same bound as the existing native result wire contract, not a new resource budget.
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 16 * 1024 * 1024)
      fail('CONVERSATION_TEXT_FILE_OUTPUT_INVALID')
    const bytes = readFileSync(fd)
    if (!validateNativeConversationOutput('text/plain', bytes)) fail('CONVERSATION_TEXT_FILE_OUTPUT_INVALID')
    return { outputId: command.outputId, contentType: 'text/plain', bytes }
  } catch (error) {
    if (error.code?.startsWith('CONVERSATION_')) throw error
    fail('CONVERSATION_TEXT_FILE_OUTPUT_INVALID')
  } finally { if (fd !== undefined) closeSync(fd) }
}

export const textFileExecutionDeclaration = ({ profile, runtime, online }) => Object.freeze({
  schemaVersion: 1,
  enabled: online === true && profile?.nativeConversationTextFileEnabled === true && runtime?.nativeTextFileV1Ready === true,
  mimeTypes: Object.freeze(['text/plain']), maxSources: 0
})
