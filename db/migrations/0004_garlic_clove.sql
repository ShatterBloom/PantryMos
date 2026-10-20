-- The demo catalog counts garlic in cloves, so its item is now named "garlic clove" with "garlic" as
-- an alias (recipes read "2 garlic cloves"). Catalogs seeded before that change have the names the
-- other way round. Rename those rows in place, keeping their ids so batches, events and conversions
-- stay attached; the seed then finds "garlic clove" and adds no second item. Only the seeded shape
-- is touched: a household's own garlic (say, in grams) and households that already have a
-- "garlic clove" item are left alone.
UPDATE pantry.items i
   SET name = 'garlic clove',
       aliases = array_append(array_remove(i.aliases, 'garlic clove'), 'garlic')
 WHERE i.name = 'garlic'
   AND i.base_unit = 'count'
   AND 'garlic clove' = ANY (i.aliases)
   AND NOT EXISTS (
         SELECT 1 FROM pantry.items o WHERE o.household_id = i.household_id AND lower(o.name) = 'garlic clove');
