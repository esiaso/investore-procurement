# User manuals

User guides for SIL Procurement, Supply Chain & Inventory, one per group of users.
Everyone should read **[Getting started](00-getting-started.md)** first. It covers
signing in, the menu, notifications and approving documents.

**PDF versions** for printing and sharing are in [`pdf/`](pdf/): one per manual
(`00-index.pdf` … `11-supplier-portal.pdf`) and all of them in one volume
(`SIL-user-manuals-complete.pdf`). After changing a manual, regenerate them; see the
note at the end of this page.

| Manual | For | Built-in role(s) | Sample login* |
|---|---|---|---|
| [Getting started](00-getting-started.md) | Everyone | – | – |
| [Staff, requesters and heads of department](01-staff-and-heads-of-department.md) | Anyone who needs goods, services or petty cash; ward and department in-charges | Department / Ward Staff, Department / Ward In-charge (and every other staff role) | `ward.nurse`, `ward.incharge` |
| [Procurement](02-procurement.md) | Procurement officers and managers | Procurement Officer, Procurement Manager | `proc.officer`, `proc.manager` |
| [Stores](03-stores.md) | Storekeepers | Storekeeper | `storekeeper` |
| [Pharmacy](04-pharmacy.md) | Pharmacists and pharmacy technicians | Pharmacist, Pharmacy Technician | `pharmacist`, `pharm.tech` |
| [Point of sale](05-point-of-sale.md) | Cashiers at the pharmacy counter (and their supervisors) | POS Cashier | `cashier` |
| [Finance](06-finance.md) | Finance officers, accountants and the finance manager | Finance / Accounts, Finance Manager | `finance`, `accountant`, `finance.manager` |
| [Petty cash custodian](07-petty-cash-custodian.md) | Whoever holds a petty cash float | Finance / Accounts (custodian of a float) | `accountant` |
| [Supply chain, quality and tender committee](08-supply-chain-and-quality.md) | Supply chain manager, quality / cold-chain officer, evaluation committee members | Supply Chain Manager, Quality Officer, Tender Committee | `scm`, `quality`, `tender` |
| [Management and audit](09-management-and-audit.md) | Medical director / management, internal audit | Hospital Management, Auditor | `management`, `auditor` |
| [System administrator](10-system-administrator.md) | IT / system administrator | System Admin | `admin` |
| [Supplier portal](11-supplier-portal.md) | Suppliers' staff | Supplier | `supplier` |

\* The sample logins exist only in a training or demonstration installation loaded with the
sample hospital. They all use the password set for that installation. In production,
users are created by the administrator.

## How to read these manuals

* **Menu paths** are written as *Section → Screen*, e.g. *Payments → Payment vouchers*.
  These are the headings and entries in the left-hand menu. You only see the entries
  your role allows.
* **Buttons** are written in *italics*, e.g. *Submit for approval*.
* Amounts are in **KES**, VAT inclusive, unless a document says otherwise.
* Approval limits, tolerances and time limits quoted here are the **defaults**. Your
  hospital may have changed them. The administrator can tell you the values in force.

## Who does what (summary)

| Process | Raises | Approves | Carries out |
|---|---|---|---|
| Staff requisition (goods / services) | Any staff member | Head of department; Finance manager above 500,000 | Stores (stock items), Procurement (other items) |
| Purchase requisition, RFQ, LPO / LSO | Procurement officer | Procurement manager, then Supply chain, Finance, Management by value | Procurement |
| Receiving stock (GRN) | Storekeeper / pharmacist | Inspection committee (2 people) | Stores |
| Accepting non-stock goods and services | Storekeeper / certifying officer | The requester or their department | – |
| Supplier invoice | Finance | Finance (3-way match exceptions) | – |
| Supplier payment voucher | Finance (preparer) | Finance manager; Management above 1,000,000 | Finance (releaser, not the preparer or an approver) |
| Petty cash request / advance | Any staff member | Head of department → Finance → Finance manager → Medical director, by amount | Float custodian |
| Internal (ward) requisition | Ward staff | Ward in-charge of that ward | Store / pharmacy |

The system enforces **segregation of duties**: nobody approves their own request, each
approval step is by a different person, and the person who prepares a payment cannot
release it. A blocked attempt is refused and recorded in the audit log.

## Regenerating the PDFs

The PDFs are made from these Markdown files with headless Chrome (the same engine the
application uses for its PDFs): a cover page, a table of contents, page numbers and
the screenshots embedded. After editing a manual, run `pnpm docs:pdf` (needs Chrome or
Chromium; set `CHROMIUM_PATH` if it is not Playwright's own) and commit the PDFs with the change,
so the PDFs never drift from the text.
