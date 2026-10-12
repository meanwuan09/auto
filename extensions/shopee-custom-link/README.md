# Shopee Custom Link trong Chrome dang dang nhap

Tien ich nay dung phien Shopee cua chinh Chrome profile ma ban cai vao. No chi duoc cap quyen tren `affiliate.shopee.vn/offer/custom_link` va dashboard `127.0.0.1:3210`; khong doc hay xuat cookie, mat khau hoac ma xac thuc.

1. Trong Chrome profile **quang**, mo `chrome://extensions`, bat **Developer mode**, chon **Load unpacked** va chon thu muc `C:\Users\thaot\Desktop\auto\extensions\shopee-custom-link`.
2. Trong dashboard, mo mot clip va luu URL san pham Shopee. Khong chon san pham bat ky cho clip khong lien quan.
3. Bam bieu tuong tien ich, chon clip, bam **Mo trang Shopee**. Trang Custom Link se mo trong cung Chrome profile da dang nhap.
4. Mo lai tien ich, bam **Dien URL va Sub_id**. Tren trang Shopee, kiem tra URL, `Sub_id1=Reup`, `Sub_id2=Clip<ID>`, sau do bam **Lay link** cua Shopee.
5. Mo lai tien ich, bam **Doc link vua tao**. Kiem tra link va bam **Luu vao clip**. Neu trang co nhieu link, dan dung link vao o cua tien ich truoc khi luu.

Shopee chua cap Open API cho tai khoan nay; tien ich khong goi API noi bo cua Shopee va khong tu bam nut tao link. No tu dien va doc ket qua trong trang dang nhap cua ban. Moi clip su dung mot `Sub_id2` rieng de doi chieu bao cao. URL san pham va link duoc luu trong dashboard; link affiliate khong tu dong chen vao caption hay thao tac gan san pham cua Shopee Video.
