CREATE POLICY "own trades delete" ON public.detected_trades FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "own orders delete" ON public.paper_orders FOR DELETE USING (auth.uid() = user_id);