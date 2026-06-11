-- Seed data for ASSESSLINK

INSERT INTO users (id, role, full_name, email, password_hash, phone, profile_photo_url, is_active, is_approved_for_login, last_login_at, created_at, updated_at) VALUES
('u-trainee-1', 'TRAINEE', 'Joseph Kurian', 'trainee@knpss.ac.ke', '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', '+254712345678', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80', true, true, NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW()),
('u-trainee-2', 'TRAINEE', 'Mary Wambui', 'mary.wambui@knpss.ac.ke', '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', '+254722111222', 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=120&auto=format&fit=crop&q=80', true, true, NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW()),
('u-trainee-3', 'TRAINEE', 'David Kimani', 'david.kimani@knpss.ac.ke', '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', '+254733444555', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&auto=format&fit=crop&q=80', true, true, NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW()),
('u-trainee-4', 'TRAINEE', 'Faith Mutua', 'faith.mutua@knpss.ac.ke', '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', '+254722999000', 'https://images.unsplash.com/photo-1534751516642-a131fed10495?w=120&auto=format&fit=crop&q=80', true, true, NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW()),
('u-officer-1', 'OFFICER', 'Mary Wanjiku', 'officer@knpss.ac.ke', '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', '+254799000111', 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=120&auto=format&fit=crop&q=80', true, true, NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days', NOW()),
('u-supervisor-1', 'SUPERVISOR', 'John Mwangi', 'supervisor@corporates.com', '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', '+254711223344', 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=120&auto=format&fit=crop&q=80', true, true, NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days', NOW()),
('u-admin-1', 'ADMIN', 'Dr. James Kamau', 'admin@knpss.ac.ke', '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', '+254700999888', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=120&auto=format&fit=crop&q=80', true, true, NOW() - INTERVAL '90 days', NOW() - INTERVAL '90 days', NOW());

INSERT INTO trainee_profiles (id, user_id, admission_no, course_code, course_name, cohort, attachment_duration_weeks, eligibility_status, fee_paid, created_at) VALUES
('tp-1', 'u-trainee-1', 'KNPSS/DICT/2022/4102', 'DICT', 'Diploma in Information Communication Technology', '2023 Intake', 12, 'ELIGIBLE', true, NOW() - INTERVAL '29 days'),
('tp-2', 'u-trainee-2', 'KNPSS/DEEE/2022/9104', 'DEEE', 'Diploma in Electrical & Electronic Engineering', '2023 Intake', 12, 'PENDING', false, NOW() - INTERVAL '29 days'),
('tp-3', 'u-trainee-3', 'KNPSS/DME/2022/1049', 'DME', 'Diploma in Mechanical Engineering', '2023 Intake', 12, 'ELIGIBLE', true, NOW() - INTERVAL '29 days'),
('tp-4', 'u-trainee-4', 'KNPSS/DBAT/2022/5021', 'DBAT', 'Diploma in Building & Civil Technology', '2023 Intake', 12, 'ELIGIBLE', true, NOW() - INTERVAL '29 days');

INSERT INTO placements (id, trainee_id, company_name, company_address, supervisor_id, supervisor_name, supervisor_phone, supervisor_email, location_lat, location_lng, county, start_date, end_date, status, assigned_officer_id, acceptance_letter_url, ilo_letter_url, created_at, updated_at) VALUES
('pl-1', 'tp-1', 'Kenya Power and Lighting Company', 'Electricity House, Harambee Avenue, Nairobi', 'u-supervisor-1', 'John Mwangi', '+254711223344', 'supervisor@corporates.com', -1.2858, 36.8229, 'Nairobi', '2026-05-01', '2026-07-24', 'ACTIVE', 'u-officer-1', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', NOW() - INTERVAL '28 days', NOW()),
('pl-2', 'tp-2', 'Athee River Cement Works', 'Mombasa Road, Athi River', NULL, 'Eng. Robert Nandi', '+254722556677', 'nandi@athicement.co.ke', -1.4518, 36.9620, 'Machakos', '2026-06-10', '2026-08-30', 'PLACED', 'u-officer-1', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', NULL, NOW() - INTERVAL '5 days', NOW()),
('pl-3', 'tp-3', 'Kenya Ports Authority', 'Kilindini Harbour, Mombasa', NULL, 'Capt. Abdi Juma', '+254733123456', 'juma@kpa.co.ke', -4.0435, 39.6682, 'Mombasa', '2026-05-15', '2026-08-15', 'ACTIVE', 'u-officer-1', NULL, NULL, NOW() - INTERVAL '15 days', NOW()),
('pl-4', 'tp-4', 'KenGen Kisumu Power Station', 'Kenyagen Sector, Kisumu', NULL, 'Sarah Koech', '+254712456789', 'koech@kengen.co.ke', -0.0917, 34.7680, 'Kisumu', '2026-03-01', '2026-05-24', 'COMPLETED', 'u-officer-1', NULL, NULL, NOW() - INTERVAL '90 days', NOW());

INSERT INTO logbook_entries (id, placement_id, entry_date, week_number, activities_description, skills_acquired, tools_used, supervisor_name, file_urls, file_hashes, status, version, is_late, officer_comments, rubric_scores, reviewed_at, reviewed_by, supervisor_acknowledged, supervisor_comment, supervisor_acknowledged_at, created_at, updated_at) VALUES
('le-1', 'pl-1', '2026-05-04', 1, 'Attended safety induction training. Introduced to the power grid configuration and control center protocols. Reviewed schematic symbols for circuit breakers and transformers.', 'Understanding grid system safety guidelines and interpreting high-voltage equipment schematics.', 'KPLC Grid Safety Manual, Schematic Draw tools', 'John Mwangi', ARRAY['https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=600&auto=format&fit=crop&q=80'], ARRAY['d8a43f9a74bf1'], 'APPROVED', 1, false, 'Excellent summary. Clear understanding of safety principles shown.', '{"Attendance":5,"Quality of Report":4,"Technical Skills":4,"Use of Tools":4,"Safety Compliance":5,"Professional Conduct":5,"Learning Progress":4}', NOW() - INTERVAL '20 days', 'u-officer-1', true, 'Quick learner, followed all safety commands during orientation.', NOW() - INTERVAL '21 days', '2026-05-04T17:00:00Z', '2026-05-04T18:30:00Z'),
('le-2', 'pl-1', '2026-05-05', 1, 'Participated in maintenance of an 11KV outdoor transformer terminal. Cleaned insulator bushings, tightened bolted busbar clamps, and verified grease level of isolator levers.', 'Insulator bushing sanitization and thermal-lever joint compression techniques.', 'Insulator cleaner, ratchet wrench, contact resistance meter', 'John Mwangi', ARRAY['https://images.unsplash.com/photo-1581092335397-9583fe92d232?w=600&auto=format&fit=crop&q=80'], ARRAY['c2b45f9c44ab2'], 'APPROVED', 1, false, 'Good hand-on experience log. Very specific on tasks.', '{"Attendance":5,"Quality of Report":5,"Technical Skills":4,"Use of Tools":4,"Safety Compliance":5,"Professional Conduct":4,"Learning Progress":5}', NOW() - INTERVAL '20 days', 'u-officer-1', true, 'Successfully assisted team. Highly observant.', NOW() - INTERVAL '20 days', '2026-05-05T17:15:00Z', NOW()),
('le-3', 'pl-1', '2026-06-01', 5, 'Configured local area network nodes at KPLC offices. Interfaced edge switches, terminated Category 6 solid cables utilizing impact-punch blocks, and certified pin assignment continuity.', 'Structured copper cabling, punch-termination, Ethernet diagnostics.', 'Fluke cable analyzer, impact punch-down tool, modular crimper', 'John Mwangi', ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'SUBMITTED', 1, false, NULL, NULL, NULL, NULL, false, NULL, NULL, '2026-06-01T16:45:00Z', NOW()),
('le-4', 'pl-1', '2026-06-02', 5, 'Troubleshooted optical fiber patch panel in the server room. Located a macro-bend in single-mode fiber patch cord using visual fault locator (VFL), replaced cord, and audited light attenuation loss.', 'OTDR / VFL trace verification and signal budget auditing.', 'Visual Fault Locator, Fiber cleaner pen', 'John Mwangi', ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'CORRECTION_REQUESTED', 1, false, 'Please describe what attenuation reading you achieved after replacing the fiber patch cord so we can assess practical learning.', NULL, NOW() - INTERVAL '20 days', NULL, false, NULL, NULL, '2026-06-02T17:10:00Z', NOW());

INSERT INTO institutional_documents (id, title, category, version, file_url, file_hash, visibility, download_policy, download_limit, is_active, uploaded_by, created_at, validation_code) VALUES
('doc-1', 'KNPSS Attachment Insurance Form (All Trainees)', 'INSURANCE', 'v4.2', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', '859f7dc2a92e10a24', 'ALL', 'SINGLE', 1, true, 'u-admin-1', NOW() - INTERVAL '15 days', 'SAFE-KNP-2026'),
('doc-2', 'NITA Attachment Reimbursement Claim Form', 'NITA', 'v2.1', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', '92ba98bc72a1e', 'ALL', 'N_DOWNLOADS', 3, true, 'u-admin-1', NOW() - INTERVAL '15 days', NULL),
('doc-3', 'Industrial Attachment Handbook and Code of Conduct', 'POLICY', 'v5.0', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', 'a1a2b3c4d5e6', 'ALL', 'UNLIMITED', NULL, true, 'u-admin-1', NOW() - INTERVAL '15 days', NULL),
('doc-4', 'Liaison Office Introduction Letter (Restricted)', 'LETTER', 'v1.0', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', 'f1e2d3c4b5a6', 'PROGRAM', 'VIEW_ONLY', NULL, true, 'u-admin-1', NOW() - INTERVAL '15 days', NULL);

INSERT INTO document_entitlements (id, document_id, user_id, downloads_used) VALUES
('ent-1', 'doc-1', 'u-trainee-1', 0),
('ent-2', 'doc-2', 'u-trainee-1', 1);

INSERT INTO app_notifications (id, user_id, type, title, body, is_read, related_entity_type, related_entity_id, created_at) VALUES
('not-1', 'u-trainee-1', 'LOGBOOK_STATUS', 'Entry Correction Requested', 'Weekly entry for 2026-06-02 requires correction. Officer comments: ''Please describe attenuation reading...''', false, 'LOGBOOK_ENTRY', 'le-4', NOW() - INTERVAL '2 hours'),
('not-2', 'u-trainee-1', 'DOCUMENT', 'New Attachment Policy Document Uploaded', 'Dr. James Kamau uploaded ''KNPSS Attachment Insurance Form''', true, 'DOCUMENT', 'doc-1', NOW() - INTERVAL '1 day');

INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, metadata, ip_address, created_at) VALUES
('al-1', 'u-admin-1', 'USER_IMPORT', 'USER', 'u-trainee-1', 'Seeded trainee Joseph Kurian to DICT cohort', '127.0.0.1', NOW() - INTERVAL '30 days');

INSERT INTO sms_logs (id, phone_number, message, sender_id, status, created_at) VALUES
('sms-1', '+254712345678', 'Welcome to KNPSS Link SMS simulation.', 'KNPSS_LINK', 'SENT', NOW() - INTERVAL '30 days');

INSERT INTO attendance_records (id, placement_id, trainee_id, date, day_of_week, status, marked_by, created_at, updated_at) VALUES
('att-1', 'pl-1', 'tp-1', '2026-06-01', 'Monday', 'Present', 'John Mwangi', '2026-06-01T16:00:00Z', '2026-06-01T16:00:00Z'),
('att-2', 'pl-1', 'tp-1', '2026-06-02', 'Tuesday', 'Present', 'John Mwangi', '2026-06-02T16:00:00Z', '2026-06-02T16:00:00Z'),
('att-3', 'pl-1', 'tp-1', '2026-06-03', 'Wednesday', 'Present', 'John Mwangi', '2026-06-03T16:00:00Z', '2026-06-03T16:00:00Z'),
('att-4', 'pl-1', 'tp-1', '2026-06-04', 'Thursday', 'Half-Day', 'John Mwangi', '2026-06-04T16:00:00Z', '2026-06-04T16:00:00Z'),
('att-5', 'pl-1', 'tp-1', '2026-06-05', 'Friday', 'Present', 'John Mwangi', '2026-06-05T16:00:00Z', '2026-06-05T16:00:00Z'),
('att-6', 'pl-1', 'tp-1', '2026-06-08', 'Monday', 'Present', 'John Mwangi', '2026-06-08T16:00:00Z', '2026-06-08T16:00:00Z'),
('att-7', 'pl-1', 'tp-1', '2026-06-09', 'Tuesday', 'Present', 'John Mwangi', '2026-06-09T10:00:00Z', '2026-06-09T10:00:00Z');

INSERT INTO officer_profiles (id, user_id, employee_no, department, specialization, assigned_regions, completed_assessments_count, office_room, availability_status, created_at) VALUES
('op-1', 'u-officer-1', 'KNPSS-ASSESSOR-04', 'School of Engineering & Mechanical Arts', 'On-Site Compliance & Practical Logbook Audit', ARRAY['Nairobi Area', 'Kiambu County'], 14, 'Liaison Wing B, Room 14', 'AVAILABLE', NOW());

INSERT INTO supervisor_profiles (id, user_id, company_name, job_title, department, work_email, work_phone, office_location, max_trainees_capacity, current_assigned_trainees_count, created_at) VALUES
('sp-1', 'u-supervisor-1', 'Kenya Power and Lighting Company', 'Senior Electrical Engineering Superintendent', 'Substations & Distribution Systems', 'jmwangi@kplc.co.ke', '+254711223344', 'Stima Plaza, Block C, 4th Floor', 5, 1, NOW());

INSERT INTO admin_profiles (id, user_id, admin_staff_code, portfolio, permissions_role, office_extension, desk_location, created_at) VALUES
('ap-1', 'u-admin-1', 'KNPSS-ILO-ADMIN-01', 'Director of Industrial Liaison & Placement Services', 'SYSTEM_ADMIN', 'EXT-8012', 'Administration Block A, Suite 10', NOW());

INSERT INTO settings (id, institution_name, attachment_duration_weeks, late_window_hours, sms_api_key, sms_username, sms_sender_id, fee_collection_enabled, fee_amount, force_2fa, created_at, updated_at) VALUES
('default', 'Kenya National Polytechnic & Vocational Sciences', 12, 48, 'at_key_8f97b001a2f3', 'knpss_attachment', 'KNPSS_LINK', true, 1500, false, NOW(), NOW());
