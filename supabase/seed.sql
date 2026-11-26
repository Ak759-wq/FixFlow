-- Demo PG + sample complaints for the warden dashboard (no owner: fictional seeded residents)
insert into ff_pgs (code, name, area, warden_pin) values ('SUNRISE24', 'Sunrise Co-living (demo)', 'Srinivaspura, Bengaluru', '1234')
on conflict (code) do update set name = excluded.name;
insert into ff_complaints (pg_code, resident_name, room, category, urgency, title, description, status) values
 ('SUNRISE24','Rahul (demo)','108','Wi-Fi','Medium','Wi-Fi drops every evening','2nd floor router disconnects every evening between 7 PM and 11 PM.','open'),
 ('SUNRISE24','Sneha (demo)','302','Electricity','High','Geyser not heating water','Geyser in room 302 gives only cold water for 3 days.','open'),
 ('SUNRISE24','Priya (demo)','110','Safety','High','Room door lock is broken','Door lock of room 110 does not latch; room cannot be locked at night.','open'),
 ('SUNRISE24','Imran (demo)','205','Food','High','Insect found in lunch dal','Insect found in dal served at lunch in the mess.','open'),
 ('SUNRISE24','Karthik (demo)','214','Water','Low','Bathroom tap keeps dripping','Bathroom tap in 214 drips all night.','open');
-- backdate for realistic day counters
update ff_complaints set reported_at = now() - interval '6 days' where owner is null and title like 'Wi-Fi%';
update ff_complaints set reported_at = now() - interval '3 days' where owner is null and title like 'Geyser%';
update ff_complaints set reported_at = now() - interval '1 day' where owner is null and title like 'Room door%';
update ff_complaints set reported_at = now() - interval '5 days' where owner is null and title like 'Insect%';
update ff_complaints set reported_at = now() - interval '9 days' where owner is null and title like 'Bathroom tap%';
update ff_complaint_events e set created_at = c.reported_at from ff_complaints c
 where e.complaint_id = c.id and c.owner is null and c.pg_code = 'SUNRISE24';
-- warden progress (logged to status history)
update ff_complaints set status = 'in_progress', warden_note = 'Technician booked to replace the 2nd floor router' where owner is null and title like 'Wi-Fi%';
update ff_complaints set status = 'fixed', warden_note = 'Mess staff briefed; dal vessels now covered' where owner is null and title like 'Insect%';
update ff_complaints set status = 'fixed', warden_note = 'Washer replaced' where owner is null and title like 'Bathroom tap%';
update ff_complaint_events e set created_at = c.reported_at + interval '1 day', actor = 'warden' from ff_complaints c
 where e.complaint_id = c.id and e.kind = 'status' and c.owner is null and c.pg_code = 'SUNRISE24';
update ff_complaints set fixed_at = reported_at + interval '1 day', updated_at = reported_at + interval '1 day' where owner is null and pg_code = 'SUNRISE24' and status <> 'open';
update ff_complaints set updated_at = reported_at where owner is null and pg_code = 'SUNRISE24' and status = 'open';
update ff_complaints set supporters = 4 where owner is null and title like 'Wi-Fi%';
update ff_complaints set supporters = 2 where owner is null and title like 'Geyser%';
