import os
import re
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from pydantic import BaseModel
from typing import List
from supabase import create_client, Client
from gotrue.errors import AuthApiError
from dotenv import load_dotenv

# IMPORT FACE VALIDATOR
try:
    from modules.eyes import FaceRegistrar
except ImportError:
    from eyes import FaceRegistrar

load_dotenv()

# SETUP
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("❌ CRITICAL: Missing Supabase Credentials")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
router = APIRouter(prefix="/auth", tags=["Authentication"])

face_validator = FaceRegistrar()
ANGLE_ORDER = ["CENTER", "LEFT", "RIGHT", "UP", "DOWN"]

def validate_username(username: str):
    username = username.lower().strip()
    if not re.match(r"^[a-z0-9_]{3,20}$", username):
        raise HTTPException(status_code=400, detail="Username must be 3-20 chars (a-z, 0-9, _).")
    return username

def get_email(username: str):
    return f"{username}@avaani.app"

# ==========================================
# 0. CHECK AVAILABILITY
# ==========================================
@router.get("/check/{username}")
async def check_username(username: str):
    """Checks if username is taken in PROFILES or AUTH."""
    clean_user = username.lower().strip()
    email = get_email(clean_user)
    
    # 1. Check Public Profiles
    res = supabase.table("profiles").select("id").eq("username", clean_user).execute()
    if res.data:
        return {"available": False, "reason": "Username taken"}

    # 2. Check Auth System
    try:
        users = supabase.auth.admin.list_users()
        for u in users:
            if u.email == email:
                return {"available": False, "reason": "Username reserved (Auth conflict)"}
    except:
        pass

    return {"available": True}

# ==========================================
# 1. BIOMETRIC SIGNUP
# ==========================================
@router.post("/signup")
async def signup(
    username: str = Form(...),
    password: str = Form(..., min_length=6),
    full_name: str = Form(...),
    face_images: List[UploadFile] = File(...) 
):
    print(f"📝 Signup Attempt: {username}")
    clean_username = validate_username(username)
    email = get_email(clean_username)

    if len(face_images) != 5:
        raise HTTPException(status_code=400, detail=f"Expected 5 images, got {len(face_images)}")
    # 1. Double-Check Uniqueness
    existing = supabase.table("profiles").select("id").eq("username", clean_username).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail="Username taken.")

    user_id = None
    try:
        # 2. Create Auth User
        try:
            auth_res = supabase.auth.admin.create_user({
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": {"username": clean_username, "full_name": full_name}
            })
            user_id = auth_res.user.id
        except AuthApiError as e:
            if "already been registered" in str(e):
                raise HTTPException(status_code=409, detail="Username is legally taken (Auth collision).")
            raise e

        # 3. Create/Update Profile (THE FIX)
        # Using .upsert() instead of .insert() prevents the "Duplicate Key" error
        # if a Database Trigger has already created the row.
        supabase.table("profiles").upsert({
            "id": user_id,
            "username": clean_username,
            "full_name": full_name,
            "avatar_url": "" 
        }).execute()

        primary_url = ""
        for i, img_file in enumerate(face_images):
            content = await img_file.read()
            required_angle = ANGLE_ORDER[i]
            
            # ⚡ FIX: Unpack the tuple properly!
            is_valid, stability = face_validator.validate_angle(content, required_angle)
            if not is_valid:
                print(f"⚠️ Image {i} ({required_angle}) check failed. Proceeding for UX (or you can raise HTTPException here).")

            path = f"{user_id}/pose_{i}.jpg"
            supabase.storage.from_("faces").upload(path, content, {"content-type": "image/jpeg", "upsert": "true"})
            if i == 0: primary_url = supabase.storage.from_("faces").get_public_url(path)

        # 5. Finalize Avatar URL
        supabase.table("profiles").update({"avatar_url": primary_url}).eq("id", user_id).execute()
        
        print(f"✅ Signprimarup Success: {clean_username}")
        return {"status": "success", "user": {"id": user_id, "username": clean_username}}

    except Exception as e:
        print(f"❌ Signup Failed: {e}")
        # CLEANUP: Delete orphaned auth user if anything failed
        if user_id: 
            try:
                supabase.auth.admin.delete_user(user_id)
                print(f"🧹 Cleanup: Deleted orphaned user {user_id}")
            except: pass
            
        status = 409 if "taken" in str(e) or "registered" in str(e) else 500
        raise HTTPException(status_code=status, detail=str(e))

# ==========================================
# 2. LOGIN API
# ==========================================
class LoginSchema(BaseModel):
    username: str
    password: str

@router.post("/login")
async def login(credentials: LoginSchema):
    try:
        clean_username = validate_username(credentials.username)
        email = get_email(clean_username)
        
        # Authenticate
        res = supabase.auth.sign_in_with_password({"email": email, "password": credentials.password})
        if not res.session: raise HTTPException(status_code=401, detail="Invalid credentials.")
        
        # Load History
        history = []
        try:
            chat_res = supabase.table("chats").select("role, content").eq("user_id", res.user.id).order("created_at", desc=True).limit(20).execute()
            if chat_res.data: history = chat_res.data[::-1]
        except: pass

        return {
            "status": "success", "access_token": res.session.access_token,
            "user": {"id": res.user.id, "username": res.user.user_metadata.get("username"), "full_name": res.user.user_metadata.get("full_name")},
            "history": history
        }
    except Exception: raise HTTPException(status_code=401, detail="Login failed.")

# ... inside modules/auth.py ...

@router.post("/validate-face")
async def validate_face_angle(
    angle: str = Form(...),
    image: UploadFile = File(...)
):
    """
    Lightweight check used by Frontend loop.
    Returns 200 OK if angle is correct, 400 if not.
    """
    content = await image.read()
    
    # ⚡ FIX: Unpack the tuple properly!
    is_valid, stability = face_validator.validate_angle(content, angle)
    
    if is_valid:
        return {"status": "ok", "message": "Angle Correct", "stability": stability}
    else:
        raise HTTPException(status_code=400, detail="Angle Incorrect")