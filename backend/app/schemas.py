"""Typed contracts shared by the extension, the agents and the API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Lang = Literal["uz", "ru", "en"]


# --- captured context (what the extension sends us) -------------------------


class Profile(BaseModel):
    username: str
    full_name: str = ""
    biography: str = ""
    followers: int = 0
    following: int = 0
    media_count: int = 0
    category: str | None = None
    is_business: bool = False
    is_verified: bool = False
    external_url: str | None = None


class Reel(BaseModel):
    code: str
    username: str | None = None
    caption: str = ""
    views: int = 0
    likes: int = 0
    comments: int = 0
    taken_at: int | None = None
    duration: float | None = None
    audio_title: str | None = None
    is_original_audio: bool = False
    video_url: str | None = None


class Comment(BaseModel):
    id: str = ""
    text: str = ""
    username: str | None = None
    likes: int = 0


class Account(BaseModel):
    profile: Profile
    reels: list[Reel] = Field(default_factory=list)


# --- agent outputs ----------------------------------------------------------


class ProfileReport(BaseModel):
    niche: str = Field(description="The creator's niche in 3-6 words")
    voice: str = Field(description="How this creator talks: tone, person, energy, recurring devices")
    pillars: list[str] = Field(description="3-5 recurring content pillars actually present in the reels")
    what_works: list[str] = Field(description="3-4 concrete patterns that correlate with the best performing reels")
    what_fails: list[str] = Field(description="2-4 patterns that correlate with the weakest reels")
    cadence: str = Field(description="Posting rhythm observed, and the rhythm to aim for")
    recommendations: list[str] = Field(description="Exactly 3 specific, do-this-next actions")
    score: int = Field(ge=0, le=100, description="Overall profile health 0-100")


class ReelReport(BaseModel):
    hook: str = Field(description="What literally happens and is said in the first 3 seconds")
    hook_type: str = Field(description="curiosity | pain | contrast | number | story | shock | promise")
    hook_score: int = Field(ge=0, le=10)
    structure: list[str] = Field(description="Beat-by-beat timeline, each item like '0-3s hook: ...'")
    on_screen_text: list[str] = Field(default_factory=list, description="Text overlays seen in the video")
    why_it_works: list[str] = Field(description="3-5 reasons this reel earned its reach")
    audience_questions: list[str] = Field(
        default_factory=list, description="What commenters actually ask or complain about"
    )
    transcript: str = Field(default="", description="Spoken words, verbatim, in the original language")
    remake_script: str = Field(
        description="A full ready-to-record script adapting this format to the target creator, in the requested language"
    )


class CompareRow(BaseModel):
    metric: str
    me: str
    them: str
    winner: Literal["me", "them", "tie"]


class BreakoutReel(BaseModel):
    code: str
    caption: str = ""
    views: int = 0


class StealIdea(BaseModel):
    format: str = Field(description="The reusable format template, e.g. '3 mistakes + talking head + text overlay, 12s'")
    why: str = Field(description="Why it works for their audience and would transfer to mine")
    example_hook: str = Field(description="A hook written for MY niche, in the requested language")


class CompetitorReport(BaseModel):
    table: list[CompareRow] = Field(default_factory=list)
    breakouts: list[BreakoutReel] = Field(default_factory=list)
    they_win_at: list[str]
    i_win_at: list[str]
    gaps: list[str] = Field(description="Topics their audience asks for that nobody is covering well")
    steal_these: list[StealIdea] = Field(description="Exactly 5 transferable formats")
    posting_advice: str = ""


class LeadMagnet(BaseModel):
    keyword: str = Field(description="Short comment trigger, usually a single symbol or word like '+' or 'GUIDE'")
    public_reply: str = Field(description="Short public reply posted under the comment")
    dm_text: str = Field(description="The DM to send, in the requested language, including the link placeholder")
    link: str = Field(default="", description="Link to deliver, empty if the creator must fill it in")


class Idea(BaseModel):
    title: str
    format: str = "reel"
    why_it_fits: str
    hooks: list[str] = Field(description="3 alternative hooks in the requested language")
    script: str = Field(description="Full script: hook, body beats, CTA — ready to record")
    shot_list: list[str] = Field(default_factory=list)
    caption: str = ""
    hashtags: list[str] = Field(default_factory=list)
    lead_magnet: LeadMagnet | None = None


class IdeaPack(BaseModel):
    ideas: list[Idea] = Field(description="Exactly 5 ideas")


# --- API request bodies -----------------------------------------------------


class AnalyzeProfileReq(BaseModel):
    profile: Profile
    reels: list[Reel] = Field(default_factory=list)
    lang: Lang = "uz"


class AnalyzeReelReq(BaseModel):
    reel: Reel
    comments: list[Comment] = Field(default_factory=list)
    my_profile: Profile | None = None
    video_b64: str | None = None
    lang: Lang = "uz"


class CompareReq(BaseModel):
    me: Account
    them: Account
    them_comments: list[Comment] = Field(default_factory=list)
    lang: Lang = "uz"


class IdeasReq(BaseModel):
    profile_report: ProfileReport
    competitor_report: CompetitorReport | None = None
    reel_reports: list[ReelReport] = Field(default_factory=list)
    lang: Lang = "uz"


class RuleReq(BaseModel):
    keyword: str
    public_reply: str = ""
    dm_text: str
    link: str = ""


class ToggleReq(BaseModel):
    id: str
