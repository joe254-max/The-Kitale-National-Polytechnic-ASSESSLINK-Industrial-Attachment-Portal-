# ASSESSLINK / KNPSS Link

An Industrial Attachment Management system.

## Security Controls & Policies

- **Role-Based Access Control**: Highly refined middleware securing all protected endpoints based on verified application roles (`TRAINEE`, `OFFICER`, `SUPERVISOR`, `ADMIN`).
- **Input & Storage Filtering**: Real-time ownership validation on placements and logbook entry fetches to prevent horizontal privilege escalation.
- **Strict Rate Limiting**: Limiters added on vital authentication endpoints.
- **Robust File Validation**: 10MB limits, magic-byte sniffing on uploads, explicit mime allowlists, attachment content disposition override on active media, and rigorous ownership access checks per file download.

> [!CAUTION]
> Rotate `SUPABASE_SERVICE_ROLE_KEY` immediately if it has ever been committed, zipped, or shared outside a secrets manager.
