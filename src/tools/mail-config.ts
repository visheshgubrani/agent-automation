import { parseArgs } from 'node:util'
import { db, pool } from '../db/index.js'
import { errorMessage } from '../errors.js'
import {
  addBankSender,
  addCompanyDomain,
  disableBankSender,
  disableCompanyDomain,
  listBankSenders,
  listCompanyDomains,
} from '../mail/config.js'

const USAGE = `Usage:
  pnpm mail:config company-domains list [--all]
  pnpm mail:config company-domains add <domain> [--label <label>] [--note <note>]
  pnpm mail:config company-domains disable <domain>
  pnpm mail:config bank-senders list [--all]
  pnpm mail:config bank-senders add <email> [--name <name>] [--note <note>]
  pnpm mail:config bank-senders disable <email>`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      all: { type: 'boolean', default: false },
      label: { type: 'string' },
      note: { type: 'string' },
      name: { type: 'string' },
    },
    allowPositionals: true,
  })
  const [group, command, value] = positionals

  if (group === 'company-domains') {
    switch (command) {
      case 'list': {
        const rows = await listCompanyDomains(db, { includeInactive: values.all })
        if (rows.length === 0) {
          console.log('No company domains configured.')
          return
        }
        for (const row of rows) {
          const details = [row.active ? 'active' : 'inactive', row.label, row.note]
            .filter(Boolean)
            .join(' | ')
          console.log(`${row.domain}  ${details}`)
        }
        return
      }
      case 'add': {
        if (!value) {
          console.error(USAGE)
          process.exitCode = 1
          return
        }
        const row = await addCompanyDomain(db, {
          domain: value,
          ...(values.label !== undefined ? { label: values.label } : {}),
          ...(values.note !== undefined ? { note: values.note } : {}),
        })
        console.log(`Company domain ${row.domain} is ${row.active ? 'active' : 'inactive'}.`)
        return
      }
      case 'disable': {
        if (!value) {
          console.error(USAGE)
          process.exitCode = 1
          return
        }
        const row = await disableCompanyDomain(db, value)
        console.log(`Company domain ${row.domain} is now inactive.`)
        return
      }
      default:
        console.error(USAGE)
        process.exitCode = 1
    }
    return
  }

  if (group === 'bank-senders') {
    switch (command) {
      case 'list': {
        const rows = await listBankSenders(db, { includeInactive: values.all })
        if (rows.length === 0) {
          console.log('No bank senders configured.')
          return
        }
        for (const row of rows) {
          const details = [row.active ? 'active' : 'inactive', row.displayName, row.note]
            .filter(Boolean)
            .join(' | ')
          console.log(`${row.email}  ${details}`)
        }
        return
      }
      case 'add': {
        if (!value) {
          console.error(USAGE)
          process.exitCode = 1
          return
        }
        const row = await addBankSender(db, {
          email: value,
          ...(values.name !== undefined ? { displayName: values.name } : {}),
          ...(values.note !== undefined ? { note: values.note } : {}),
        })
        console.log(`Bank sender ${row.email} is ${row.active ? 'active' : 'inactive'}.`)
        return
      }
      case 'disable': {
        if (!value) {
          console.error(USAGE)
          process.exitCode = 1
          return
        }
        const row = await disableBankSender(db, value)
        console.log(`Bank sender ${row.email} is now inactive.`)
        return
      }
      default:
        console.error(USAGE)
        process.exitCode = 1
    }
    return
  }

  console.error(USAGE)
  process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
