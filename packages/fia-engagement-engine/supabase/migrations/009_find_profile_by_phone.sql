-- Robust phone matching for group rosters / inbound resolution.
-- Profiles store phones in inconsistent formats (+54 9 11..., +541139..., 5491161..., spaces,
-- with/without the Argentine mobile "9"), while WhatsApp/Evolution always sends pure digits
-- WITH the 9 (549...). Exact matching missed most students. We compare the canonical national
-- number = last 10 digits of the stripped phone (area code + subscriber), which is stable
-- across country code, the mobile "9", "+" and spaces.
CREATE OR REPLACE FUNCTION find_profile_by_phone(p_phone text)
RETURNS SETOF profiles
LANGUAGE sql STABLE AS $$
  SELECT p.*
  FROM profiles p
  WHERE length(regexp_replace($1, '\D', '', 'g')) >= 8
    AND right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10)
        = right(regexp_replace($1, '\D', '', 'g'), 10)
  LIMIT 1;
$$;
