-- remove test accounts (and their data via cascade) and reset demo PG complaints
delete from ff_photos where owner in (select id from auth.users where email like 'fftest%');
delete from auth.users where email like 'fftest%';
delete from ff_complaints where pg_code = 'SUNRISE24' and owner is null;
