-- Demo PG + sample complaints for the warden dashboard (no owner: seeded residents)
insert into ff_pgs (code, name, area, warden_pin) values ('SUNRISE24', 'Sunrise Co-living', 'Srinivaspura, Bengaluru', '1234')
on conflict (code) do nothing;
insert into ff_complaints (pg_code, resident_name, room, category, urgency, title, description, status) values
 ('SUNRISE24','Rahul','108','Wi-Fi','Medium','Wi-Fi drops every evening','2nd floor router disconnects every evening between 7 PM and 11 PM.','in_progress'),
 ('SUNRISE24','Sneha','302','Electricity','High','Geyser not heating water','Geyser in room 302 gives only cold water for 3 days.','open'),
 ('SUNRISE24','Priya','110','Safety','High','Room door lock is broken','Door lock of room 110 does not latch; room cannot be locked at night.','open'),
 ('SUNRISE24','Imran','205','Food','High','Insect found in lunch dal','Insect found in dal served at lunch in the mess.','fixed'),
 ('SUNRISE24','Karthik','214','Water','Low','Bathroom tap keeps dripping','Bathroom tap in 214 drips all night.','fixed');
-- backdate for realistic day counters
update ff_complaints set reported_at = now() - interval '6 days' where title like 'Wi-Fi%';
update ff_complaints set reported_at = now() - interval '3 days' where title like 'Geyser%';
update ff_complaints set reported_at = now() - interval '1 day' where title like 'Room door%';
update ff_complaints set reported_at = now() - interval '5 days', fixed_at = now() - interval '4 days' where title like 'Insect%';
update ff_complaints set reported_at = now() - interval '9 days', fixed_at = now() - interval '6 days' where title like 'Bathroom tap%';
update ff_complaints set supporters = 4 where title like 'Wi-Fi%';
update ff_complaints set supporters = 2 where title like 'Geyser%';
