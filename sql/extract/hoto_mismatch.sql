-- Purpose: HOTO mismatch flags recorded at the welcome call (D-74), one row per project handed over since 2025-01-01.
-- The pipeline packs them into a bitmask (order = the column order below). Flags only; no customer data.
SELECT p._id AS project_id,
       p.finance_mode_mismatch, p.project_timeline_mismatch, p.site_status_mismatch, p.payment_terms_mismatch,
       p.bill_correction_scope_mismatch, p.phase_change_mismatch, p.name_change_mismatch, p.load_change_mismatch,
       p.structure_table_mismatch, p.number_of_modules_mismatch, p.module_make_mismatch, p.address_mismatch,
       p.customer_first_name_mismatch, p.customer_last_name_mismatch, p.aadhar_card_front_mismatch, p.aadhar_card_back_mismatch,
       p.pan_card_mismatch, p.property_tax_mismatch, p.cancelled_cheque_mismatch, p.customer_photo_mismatch, p.property_document_mismatch
FROM project p
WHERE p."isDelete" = '0' AND p.sales_handover_datetime >= '2025-01-01'
