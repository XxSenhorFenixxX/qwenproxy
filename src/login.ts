import type { QwenAccount } from './core/accounts.js';
import { addAccount, removeAccount, listAccounts, getAccountCredentials } from './core/accounts.js'
import type { BrowserType} from './services/playwright.js';
import { initPlaywrightForAccount, closePlaywrightForAccount, launchManualLoginAccount, extractAccountInfoFromContext, saveStorageState, importSessionFromRunningBrowser, resolveBraveExecutable } from './services/playwright.js'
import * as readline from 'readline'
import * as dotenv from 'dotenv'
import * as net from 'net'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

async function launchBraveWithDebugPort(debugPort: number): Promise<boolean> {
  const bravePath = resolveBraveExecutable()
  if (!bravePath) return false

  // If another Brave instance is running, --remote-debugging-port would be
  // ignored (Chromium just opens a new tab in the existing instance). Using a
  // dedicated --user-data-dir forces a brand-new independent instance, so the
  // debugging port actually opens. That instance shares no cookies with the
  // user's normal Brave — they will log in again there (as a real user).
  const profileDir = path.join(process.cwd(), 'qwen_profiles', 'manual_import')
  fs.mkdirSync(profileDir, { recursive: true })

  console.log(`\n  Launching: ${bravePath} --remote-debugging-port=${debugPort} --user-data-dir=${profileDir}`)
  const child = spawn(bravePath, [
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
  ], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  // Wait up to ~20s for the debugging port to open.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (await isPortOpen(debugPort)) {
      console.log('  Browser is listening on the debugging port.\n')
      return true
    }
  }
  console.log('  [!] The debugging port did not open in time.')
  return false
}

dotenv.config()

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function askQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim())
    })
  })
}

function clear() {
  process.stdout.write('\x1Bc')
}

async function showMenu() {
  let browserType: BrowserType = 'chromium'
  const browserArg = process.argv.find(arg => arg.startsWith('--browser='))
  if (browserArg) {
    browserType = browserArg.split('=')[1] as BrowserType
  } else if (process.env.BROWSER) {
    browserType = process.env.BROWSER as BrowserType
  }

  while (true) {
    const accounts = listAccounts()
    clear()
    console.log('=== QwenProxy Account Manager ===\n')

    if (accounts.length > 0) {
      console.log(`Configured accounts (${accounts.length}):\n`)
      for (let i = 0; i < accounts.length; i++) {
        console.log(`  [${i + 1}] ${accounts[i].email} (ID: ${accounts[i].id})`)
      }
    } else {
      console.log('No accounts configured yet.\n')
    }

    console.log('\nOptions:')
    console.log('  [A] Add account (with credentials)')
    console.log('  [M] Add account (manual browser login)')
    console.log('  [E] Import session from a running browser (works around anti-bot)')
    if (accounts.length > 0) {
      console.log('  [P] Set/update password for an account (needed for auto re-login)')
      console.log('  [R] Remove an account')
      console.log('  [L] Login all accounts')
    }
    console.log('  [Q] Quit\n')

    const choice = (await askQuestion('Select an option: ')).toUpperCase()

    if (choice === 'Q') {
      rl.close()
      process.exit(0)
    }

    if (choice === 'A') {
      await addAccountFlow()
      continue
    }

    if (choice === 'M') {
      await addAccountManualFlow(browserType)
      continue
    }

    if (choice === 'E') {
      await importSessionFromRunningBrowserFlow()
      continue
    }

    if (choice === 'P' && accounts.length > 0) {
      await setPasswordFlow()
      continue
    }

    if (choice === 'R' && accounts.length > 0) {
      await removeAccountFlow()
      continue
    }

    if (choice === 'L' && accounts.length > 0) {
      await loginAllAccounts(browserType)
      rl.close()
      return
    }
  }
}

async function addAccountFlow() {
  clear()
  console.log('=== Add New Account ===\n')
  const email = await askQuestion('Email: ')
  if (!email) {
    console.log('Email is required.')
    await askQuestion('Press Enter to continue...')
    return
  }
  const password = await askQuestion('Password: ')
  if (!password) {
    console.log('Password is required.')
    await askQuestion('Press Enter to continue...')
    return
  }

  try {
    const account = addAccount(email, password)
    console.log(`\nAccount added: ${account.email} (${account.id})`)
  } catch (err: any) {
    console.log(`\nError: ${err.message}`)
  }

  await askQuestion('Press Enter to continue...')
}

async function removeAccountFlow() {
  const accounts = listAccounts()
  if (accounts.length === 0) return

  clear()
  console.log('=== Remove Account ===\n')

  for (let i = 0; i < accounts.length; i++) {
    console.log(`  [${i + 1}] ${accounts[i].email} (ID: ${accounts[i].id})`)
  }

  const input = await askQuestion('\nSelect account number to remove (or 0 to cancel): ')
  const idx = parseInt(input) - 1

  if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
    console.log(input !== '0' ? 'Invalid selection.' : 'Cancelled.')
    await askQuestion('Press Enter to continue...')
    return
  }

  const account = accounts[idx]
  const confirm = await askQuestion(`\nRemove ${account.email}? (y/N): `)
  if (confirm.toLowerCase() === 'y') {
    if (removeAccount(account.id)) {
      console.log(`Account ${account.email} removed.`)
    } else {
      console.log('Failed to remove account.')
    }
  } else {
    console.log('Cancelled.')
  }

  await askQuestion('Press Enter to continue...')
}

async function setPasswordFlow() {
  const accounts = listAccounts()
  if (accounts.length === 0) return

  clear()
  console.log('=== Set/Update Account Password ===\n')
  console.log('Accounts without a password cannot re-login automatically when the session expires.')
  console.log('If you use Google OAuth, you can\'t set a password here — use [E] to re-import sessions.\n')

  for (let i = 0; i < accounts.length; i++) {
    const hasPw = accounts[i].password !== '***' && accounts[i].password !== ''
    console.log(`  [${i + 1}] ${accounts[i].email} ${hasPw ? '' : '(⚠ NO PASSWORD SET)'}`)
  }

  const input = await askQuestion('\nSelect account number (or 0 to cancel): ')
  const idx = parseInt(input) - 1

  if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
    console.log(input !== '0' ? 'Invalid selection.' : 'Cancelled.')
    await askQuestion('Press Enter to continue...')
    return
  }

  const account = accounts[idx]
  console.log(`\nSetting password for ${account.email}`)
  const password = await askQuestion('New password: ')
  if (!password) {
    console.log('Password cannot be empty.')
    await askQuestion('Press Enter to continue...')
    return
  }

  try {
    const { updateAccountPassword } = await import('./core/accounts.js')
    if (updateAccountPassword(account.id, password)) {
      console.log(`\nPassword updated successfully for ${account.email}.`)
      console.log('The server will use this password for auto re-login when sessions expire.')
    } else {
      console.log('Failed to update password. Account not found.')
    }
  } catch (err: any) {
    console.log(`\nError: ${err.message}`)
  }

  await askQuestion('Press Enter to continue...')
}

async function loginAllAccounts(browserType: BrowserType) {
  const accounts = listAccounts()
  if (accounts.length === 0) return

  clear()
  console.log(`Logging in ${accounts.length} account(s) using ${browserType}...\n`)

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]
    const creds = getAccountCredentials(account.id)
    if (!creds || creds.password === '***') {
      console.log(`[Login] Skipping ${account.email} - no credentials available`)
      continue
    }
    console.log(`[Login] Processing account: ${account.email}`)
    try {
      const fullAccount: QwenAccount = {
        id: creds.id,
        email: creds.email,
        password: creds.password,
      }
      await initPlaywrightForAccount(fullAccount, true, browserType)
      console.log(`[Login] Account ${account.email} session saved.`)
      await closePlaywrightForAccount(account.id)
    } catch (err: any) {
      console.error(`[Login] Failed to login ${account.email}: ${err.message}`)
    }
  }

  console.log('\n[Login] All accounts processed.')
  await askQuestion('Press Enter to continue...')
}

async function importSessionFromRunningBrowserFlow() {
  clear()
  console.log('=== Import Session from Running Browser ===\n')
  console.log('This is the reliable path when Qwen\'s anti-bot (TMD) rejects the')
  console.log('automated login window as "not trustworthy". You will login in your')
  console.log('OWN real browser, and we will import the fresh session cookies.\n')

  const portInput = await askQuestion('Debug port (default 9222): ')
  const debugPort = parseInt(portInput || '9222', 10)
  if (isNaN(debugPort)) {
    console.log('Invalid port.')
    await askQuestion('Press Enter to continue...')
    return
  }

  // Check whether the debugging port is already reachable (user may have
  // opened the browser manually, or we launch it below).
  let portOpen = await isPortOpen(debugPort)
  if (!portOpen) {
    console.log('\nThe debugging port is not open yet. I will try to launch your browser')
    console.log('with --remote-debugging-port automatically.\n')
    portOpen = await launchBraveWithDebugPort(debugPort)
    if (!portOpen) {
      console.log('\n[!] Could not reach the browser on port ' + debugPort + '.')
      console.log('    If Brave is open, close ALL its windows first and try again.')
      console.log('    Or launch it manually in another terminal and re-run this option:')
      console.log('      brave-browser --remote-debugging-port=' + debugPort)
      await askQuestion('Press Enter to continue...')
      return
    }
  }

  console.log('\nNow, in that browser window:')
  console.log('  1. Go to https://chat.qwen.ai')
  console.log('  2. Login normally (manually), like a regular user.')
  console.log('  3. Come back here.\n')
  await askQuestion('Press Enter once you are logged in at chat.qwen.ai in that browser...')

  const crypto = await import('crypto')
  const accountId = crypto.randomUUID()

  console.log('\nConnecting to your browser and importing the session...')
  try {
    const { hasSession } = await importSessionFromRunningBrowser(debugPort, accountId)
    if (!hasSession) {
      console.log('\nNo active Qwen session found. Make sure you are logged in at chat.qwen.ai')
      console.log('in the browser opened with --remote-debugging-port, then try again.')
      await askQuestion('Press Enter to continue...')
      return
    }

    console.log('\nSession detected and cookies saved!')
    const extractedEmail = await askQuestion('Enter the email for this account: ')
    if (!extractedEmail) {
      console.log('Email is required.')
      await askQuestion('Press Enter to continue...')
      return
    }

    try {
      const account = addAccount(extractedEmail, '', accountId)
      console.log(`\nAccount added: ${account.email} (${account.id})`)
    } catch (err: any) {
      console.log(`\nError: ${err.message}`)
    }
  } catch (err: any) {
    console.log(`\nError connecting to the browser: ${err.message}`)
    console.log('Make sure the browser is open with --remote-debugging-port=' + debugPort + '.')
  }

  await askQuestion('Press Enter to continue...')
}

async function addAccountManualFlow(browserType: BrowserType) {
  clear()
  console.log('=== Add Account (Manual Login) ===\n')
  console.log('A browser window will open. Please login to Qwen manually.')
  console.log('Once logged in, close the browser window or press Ctrl+C here.\n')
  await askQuestion('Press Enter to open the browser...')

  const crypto = await import('crypto')
  const accountId = crypto.randomUUID()

  const { context, page } = await launchManualLoginAccount(accountId, browserType)

  console.log('\nBrowser opened. Waiting for you to login...')
  
  let loggedIn = false
  while (!loggedIn) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const { hasSession } = await extractAccountInfoFromContext(page)
    if (hasSession) {
      loggedIn = true
    }
  }

  console.log('\nLogin detected! Extracting account info...')

  // Persist the fresh session cookies so the proxy can pick them up later.
  await saveStorageState(context, accountId)
  console.log('Session cookies saved.')
  
  const extractedEmail = await askQuestion('Enter the email for this account: ')
  if (!extractedEmail) {
    console.log('Email is required.')
    await context.close()
    await askQuestion('Press Enter to continue...')
    return
  }

  try {
    const account = addAccount(extractedEmail, '', accountId)
    console.log(`\nAccount added: ${account.email} (${account.id})`)
  } catch (err: any) {
    console.log(`\nError: ${err.message}`)
  }

  await context.close()
  await askQuestion('Press Enter to continue...')
}

showMenu().catch(err => {
  console.error(err)
  process.exit(1)
})
